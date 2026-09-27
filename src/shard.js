'use strict';
/**
 * LedgerShard: the whole ledger engine for a set of accounts. Accounts never
 * interact, so a shard is an independent unit. The single-process replayer
 * uses one shard. The sharded replayer runs N of them in worker threads,
 * partitioned by account.
 *
 * Records:
 *  - eventLog  : one frozen record per inbound event, accepted or rejected,
 *                with a narration of what happened to it.
 *  - journal   : frozen ledger entries (the ledger). Each entry has an explicit
 *                direction (DEBIT|CREDIT), a positive amount, postingDate
 *                (day the event first arrived, never changed), valueDate,
 *                processedOnDay, from/to party blocks and a narration.
 *                Reversals, returns, refunds, charges and VAT are always
 *                SEPARATE entries that link back to the entry they relate to.
 *  - accruals  : frozen interest-accrual sub-ledger records (not part of the
 *                ledger balance until capitalized).
 * Nothing in these three arrays is ever mutated or removed. The per-account
 * state (balances by value day, holds, auth status) is a derived index. It can
 * be rebuilt from the records and is the only thing that changes.
 */
const { CODES, LedgerError, InvariantError } = require('./errors');
const money = require('./money');
const { normalizeEvent } = require('./events');
const { DEFAULT_POLICY } = require('./config');

// Packed per-account, per-value-day state: one Float64Array per account.
const F_DELTA = 0;   // net signed movement with this value day (fees included)
const F_CLOSING = 1; // closing ledger balance for this value day
const F_PREFEE = 2;  // closing balance before the fee for this day
const F_FEE = 3;     // 0 = none, 1 = fee assessed, 2 = negative but no fee configured (reported)
const F_CUMNUM = 4;  // cumulative exact interest numerator (Σ max(0,closing) × rate.num)
const F_ACCRUED = 5; // net accrual posted for this value day (Σ of accrual records)
const NF = 6;

const REVERSIBLE = new Set(['CREDIT', 'DEBIT', 'SETTLEMENT', 'CHARGE']);
const RETURNABLE = new Set(['DEBIT', 'SETTLEMENT']);
const REFUNDABLE = new Set(['DEBIT', 'SETTLEMENT', 'FEE', 'CHARGE']);
const OPPOSITE = { DEBIT: 'CREDIT', CREDIT: 'DEBIT' };

/**
 * Narrations are built with template literals, which V8 stores as rope
 * ("cons") strings: a tree of every fragment. Retained by the hundred
 * thousand, the ropes cost about 6× the flat text (measured: 354 MB vs 55 MB
 * for 200k narrations) and dominated GC time. Slicing a prefixed copy forces
 * one flat string. See WORKLOG 17:5x.
 */
const flat = (s) => (' ' + s).slice(1);

function partyText(p) {
  if (!p) return 'unspecified counterparty';
  const bits = [p.accountName, p.bankName].filter(Boolean).join(', ');
  return `${p.accountNumber ?? p.iban ?? '?'}${bits ? ` (${bits})` : ''}`;
}

/**
 * Tracking record for an entry that can later be reversed, returned or
 * refunded. It is a fixed-shape class (not a spread object literal) because
 * there is one per posting, and at 1M events the shape and size matter
 * (see WORKLOG 17:5x).
 */
class Ref {
  constructor(id, kind, direction, amount, valueDate, postingDate, parts, counterparty, transferId, vat) {
    this.id = id;
    this.kind = kind;
    this.direction = direction;
    this.amount = amount;
    this.valueDate = valueDate;
    this.postingDate = postingDate;
    this.parts = parts;               // null unless split into instalments
    this.counterparty = counterparty; // may be null
    this.transferId = transferId;     // may be null
    this.vat = vat;                   // null or { entryId, amount, refunded }
    this.consumed = 0;
    this.reversedBy = null;
  }
  get partCount() { return this.parts ? this.parts.length : 1; }
  part(i) { return this.parts ? this.parts[i] : this.amount; }
  entryId(i) { return this.parts ? `${this.id}#${i + 1}` : this.id; }
}

class Account {
  constructor(id, currency, openingMinor, lastDay, party) {
    this.id = id;
    this.currency = currency;
    this.party = party; // frozen own-side block, shared by every entry of this account
    this.L = lastDay + 1;
    this.s = new Float64Array(NF * this.L);
    this.s[F_DELTA * this.L] = openingMinor;
    this.s[F_CLOSING * this.L] = openingMinor;
    this.s[F_PREFEE * this.L] = openingMinor;
    this.book = openingMinor;        // Σ all postings (no future value dates exist)
    this.holds = 0;                  // Σ active authorization holds
    this.closedThrough = 0;
    this.dirtyFrom = Infinity;       // earliest already-closed value day touched since last close
    this.dirtyBy = null;             // event ids that back-valued into closed days since last close
    this.ids = null;                 // lazily: id → seq (seen) or Ref (referable). Idempotency scope = account
    this.auths = null;               // lazily: authId → auth state
    this.accrualSum = 0;             // Σ accrual sub-ledger amounts
    this.accrualRecords = 0;
    this.accrualAdjustments = 0;
    this.capitalized = null;
    this.today = null;               // journal entries processed since last close (detail only)
  }
  g(f, d) { return this.s[f * this.L + d]; }
  p(f, d, v) { this.s[f * this.L + d] = v; }
}

class LedgerShard {
  /**
   * @param {object} o
   * @param {Array<{id,currency,openingBalance,accountName?,bankName?,bic?,iban?}>} o.accounts
   * @param {object} [o.policy]
   * @param {boolean} [o.detail] keep per-account detail for reports
   * @param {number} [o.errorSampleLimit]
   * @param {boolean} [o.retainJournal] keep full journal in memory (default true)
   */
  constructor({ accounts, policy = DEFAULT_POLICY, detail = true, errorSampleLimit = Infinity, retainJournal = true }) {
    this.policy = policy;
    this.detail = detail;
    this.errorSampleLimit = errorSampleLimit;
    this.retainJournal = retainJournal;
    const { firstDay, lastDay } = policy.window;
    this.firstDay = firstDay;
    this.lastDay = lastDay;
    this.openDay = firstDay;
    this.windowClosed = false;
    this.accounts = new Map();
    for (const a of accounts) {
      if (this.accounts.has(a.id)) throw new InvariantError(`duplicate account ${a.id}`);
      money.currencyInfo(a.currency);
      const opening = money.parseAmount(a.openingBalance ?? '0', a.currency, { allowNegative: true });
      const party = Object.freeze({ accountNumber: a.id, accountName: a.accountName ?? null,
        bankName: a.bankName ?? policy.bank.bankName, bic: a.bic ?? policy.bank.bic ?? null, iban: a.iban ?? null });
      this.accounts.set(a.id, new Account(a.id, a.currency, opening, lastDay, party));
    }
    this.feeMinor = {};
    for (const [ccy, amt] of Object.entries(policy.overdraftFee)) this.feeMinor[ccy] = money.parseAmount(amt, ccy);
    this.eventLog = [];
    this.journal = [];
    this.accruals = [];
    this.journalCount = 0;
    this._resetDay();
  }

  _resetDay() {
    this.errors = [];
    this.errorCounts = Object.create(null);
    this.errorTotal = 0;
    this.notices = [];
    this.stats = { accepted: 0, rejected: 0 };
  }

  _fmt(acct, minor) { return `${acct.currency} ${money.format(minor, acct.currency)}`; }

  // ───────────────────────────── inbound events ─────────────────────────────

  /**
   * Apply one raw event. Business rejections are recorded and returned, never
   * thrown. Any other exception is a bug: it is recorded as INTERNAL_ERROR and
   * re-thrown so the replay stops (fail-stop) rather than continuing on state
   * that may be inconsistent.
   */
  apply(raw, seq) {
    const rawId = raw && typeof raw.id === 'string' ? raw.id : null;
    const rawAcct = raw && typeof raw.account === 'string' ? raw.account : null;
    let evt = null;
    try {
      if (this.windowClosed) throw new LedgerError(CODES.WINDOW_CLOSED, 'window has closed; capitalization done');
      evt = normalizeEvent(raw, this.policy);
      if (evt.day < this.firstDay || evt.day > this.lastDay) {
        throw new LedgerError(CODES.OUT_OF_WINDOW, `day ${evt.day} outside window ${this.firstDay}..${this.lastDay}`);
      }
      if (evt.day > this.openDay) {
        throw new InvariantError(`event ${evt.id} for day ${evt.day} delivered while day ${this.openDay} is open`);
      }
      const acct = this.accounts.get(evt.account);
      if (!acct) throw new LedgerError(CODES.UNKNOWN_ACCOUNT, `unknown account ${evt.account}`);
      if (acct.ids === null) acct.ids = new Map();
      const prior = acct.ids.get(evt.id);
      if (prior !== undefined) {
        throw new LedgerError(CODES.DUPLICATE_EVENT, `event ${evt.id} already received`
          + `${typeof prior === 'number' ? ` (seq ${prior})` : ` (posted D${prior.postingDate})`}; original postingDate is kept`);
      }
      acct.ids.set(evt.id, seq); // reserved even if rejected below: an id names one fact forever
      if (evt.currency !== null && evt.currency !== acct.currency) {
        throw new LedgerError(CODES.CURRENCY_MISMATCH, `${evt.currency} event on ${acct.currency} account ${acct.id}`);
      }
      this._checkValueDate(evt);
      const { outcome, narration } = this._dispatch(evt, acct, seq);
      if (evt.day < this.openDay) {
        this.notices.push({ seq, eventId: evt.id, account: acct.id, code: 'LATE_ARRIVAL',
          message: `postingDate D${evt.day} kept; processed during D${this.openDay} after D${evt.day} closed` });
      }
      if (evt.valueDate < evt.day && evt.type !== 'AUTHORIZATION') {
        this.notices.push({ seq, eventId: evt.id, account: acct.id, code: 'BACK_VALUED',
          message: `value D${evt.valueDate} earlier than posting D${evt.day}; days D${evt.valueDate}+ restated at close` });
      }
      this._log(seq, evt.id, evt.type, acct.id, evt.day, 'ACCEPTED', null, outcome, narration);
      this.stats.accepted++;
      return { status: 'ACCEPTED', outcome, narration };
    } catch (e) {
      if (!(e instanceof LedgerError)) {
        this._reject(seq, rawId, raw && raw.type, rawAcct, raw && raw.day, CODES.INTERNAL_ERROR, String(e && e.message));
        throw e;
      }
      this._reject(seq, rawId, evt ? evt.type : raw && raw.type, rawAcct, evt ? evt.day : raw && raw.day, e.code, e.message);
      return { status: 'REJECTED', code: e.code, message: e.message };
    }
  }

  /** Record an error that happened before the event reached a shard (e.g. malformed JSON). */
  rejectRaw(seq, code, message) { this._reject(seq, null, null, null, null, code, message); }

  _checkValueDate(evt) {
    if (evt.valueDate < this.firstDay) {
      throw new LedgerError(CODES.VALUE_DATE_TOO_OLD, `value date D${evt.valueDate} before window start`);
    }
    if (evt.valueDate > evt.day) {
      throw new LedgerError(CODES.VALUE_DATE_IN_FUTURE, `value date D${evt.valueDate} after posting day D${evt.day}`);
    }
    const max = this.policy.maxBackValueDays;
    if (max !== null && evt.day - evt.valueDate > max) {
      throw new LedgerError(CODES.VALUE_DATE_TOO_OLD, `back-valued ${evt.day - evt.valueDate} days; limit ${max}`);
    }
  }

  _dispatch(evt, acct, seq) {
    switch (evt.type) {
      case 'CREDIT':
      case 'DEBIT': return this._plain(evt, acct);
      case 'CHARGE': return this._charge(evt, acct);
      case 'AUTHORIZATION': return this._authorize(evt, acct, seq);
      case 'SETTLEMENT': return this._settle(evt, acct);
      case 'REVERSAL': return this._reverse(evt, acct);
      case 'RETURN':
      case 'REFUND': return this._refund(evt, acct);
      default: throw new InvariantError(`unhandled type ${evt.type}`);
    }
  }

  _amount(evt, acct) {
    const m = money.parseAmount(evt.amount, acct.currency);
    if (m === 0) throw new LedgerError(CODES.INVALID_AMOUNT, 'amount must be greater than zero');
    return m;
  }

  /** Pre-flight: make sure applying `signed` to the account cannot overflow. */
  _canPost(acct, valueDay, signed) {
    money.safe(acct.book + signed);
    money.safe(acct.g(F_DELTA, valueDay) + signed);
  }

  _plain(evt, acct) {
    const total = this._amount(evt, acct);
    const parts = evt.instalments > 1 ? money.allocateEqual(total, evt.instalments) : [total];
    const direction = evt.type; // CREDIT | DEBIT
    this._canPost(acct, evt.valueDate, direction === 'CREDIT' ? total : -total);
    const label = direction === 'CREDIT' ? 'Credit' : 'Debit';
    const xfer = evt.transferId ? ` [transfer ${evt.transferId}]` : '';
    const entries = parts.map((amt, i) => {
      const entryId = parts.length > 1 ? `${evt.id}#${i + 1}` : evt.id;
      const story = parts.length > 1
        ? `${label} ${evt.id} instalment ${i + 1}/${parts.length} of ${this._fmt(acct, total)}${xfer}`
        : `${label} ${evt.id}${xfer}`;
      return this._post(acct, { entryId, eventId: evt.id, kind: evt.type, direction, amount: amt,
        postingDate: evt.day, valueDate: evt.valueDate, counterparty: evt.counterparty, transferId: evt.transferId,
        instalment: parts.length > 1 ? `${i + 1}/${parts.length}` : undefined, story });
    });
    this._refer(acct, new Ref(evt.id, evt.type, direction, total, evt.valueDate, evt.day, parts.length > 1 ? parts : null,
      evt.counterparty, evt.transferId, null));
    return {
      outcome: parts.length > 1 ? `POSTED_IN_${parts.length}_INSTALMENTS` : 'POSTED',
      narration: entries.length > 1
        ? flat(`${label} ${evt.id} ${this._fmt(acct, total)} split into ${parts.length} instalments `
          + `(${parts.map((p) => money.format(p, acct.currency)).join(' + ')}); ${entries[0].narration.split('; ').slice(1).join('; ')}`)
        : entries[0].narration,
    };
  }

  _vatBps(acct) { return (this.policy.vatBps && this.policy.vatBps[acct.currency]) || 0; }
  _vatOn(acct, chargeMinor) {
    const bps = this._vatBps(acct);
    return bps === 0 ? 0 : money.divRoundHalfEven(money.safe(chargeMinor * bps), 10_000);
  }

  _charge(evt, acct) {
    const amt = this._amount(evt, acct);
    const vat = this._vatOn(acct, amt);
    this._canPost(acct, evt.valueDate, -(amt + vat));
    const chargeParty = evt.counterparty ?? this.policy.bank.gl.CHARGE_INCOME;
    const e = this._post(acct, { entryId: evt.id, eventId: evt.id, kind: 'CHARGE', direction: 'DEBIT', amount: amt,
      postingDate: evt.day, valueDate: evt.valueDate, counterparty: chargeParty, story: `Service charge ${evt.id}` });
    let vatRef = null;
    let narration = e.narration;
    if (vat > 0) {  // (joined below with +=, flattened at the end)
      vatRef = { entryId: `VAT:${evt.id}`, amount: vat, refunded: 0 };
      const v = this._post(acct, { entryId: vatRef.entryId, eventId: evt.id, kind: 'VAT', direction: 'DEBIT', amount: vat,
        postingDate: evt.day, valueDate: evt.valueDate, refersTo: evt.id, counterparty: this.policy.bank.gl.VAT_PAYABLE,
        story: `VAT ${this._vatBps(acct) / 100}% on charge ${evt.id} (${this._fmt(acct, amt)}), separate entry` });
      narration += ` | ${v.narration}`;
    }
    this._refer(acct, new Ref(evt.id, 'CHARGE', 'DEBIT', amt, evt.valueDate, evt.day, null, chargeParty, null, vatRef));
    return { outcome: vat > 0 ? 'POSTED_WITH_VAT' : 'POSTED', narration: vat > 0 ? flat(narration) : narration };
  }

  _authorize(evt, acct, seq) {
    const amt = this._amount(evt, acct);
    if (acct.auths === null) acct.auths = new Map();
    if (acct.auths.has(evt.authId)) {
      throw new LedgerError(CODES.DUPLICATE_AUTH_ID, `authorization ${evt.authId} already exists on ${acct.id}`);
    }
    const availableBefore = money.safe(acct.book - acct.holds);
    const availableAfter = money.safe(availableBefore - amt);
    const approved = availableAfter >= 0;
    const auth = {
      authId: evt.authId, eventId: evt.id, seq, amount: amt, requestedDay: evt.day, valueDate: evt.valueDate,
      state: approved ? 'APPROVED' : 'DECLINED', availableAfter,
      settledAmount: 0, releasedAmount: 0, settledBy: null, history: [], counterparty: evt.counterparty,
    };
    auth.history.push(Object.freeze({ day: this.openDay, state: auth.state, eventId: evt.id }));
    if (approved) acct.holds = money.safe(acct.holds + amt);
    acct.auths.set(evt.authId, auth);
    const narration = flat(`Authorization ${evt.authId} (${evt.id}) for ${this._fmt(acct, amt)} on ${partyText(acct.party)}`
      + ` payable to ${partyText(evt.counterparty)}: ledger ${this._fmt(acct, acct.book)} − active holds `
      + `${this._fmt(acct, approved ? acct.holds - amt : acct.holds)} − this hold ${this._fmt(acct, amt)} = available `
      + `${this._fmt(acct, availableAfter)} → ${approved ? 'APPROVED, hold placed (ledger balance unchanged)' : 'DECLINED, no hold placed'}`
      + `; requested D${evt.day}`);
    return { outcome: approved ? 'AUTH_APPROVED' : 'AUTH_DECLINED', narration };
  }

  _settle(evt, acct) {
    const amt = this._amount(evt, acct);
    const auth = acct.auths && acct.auths.get(evt.authId);
    if (!auth) {
      throw new LedgerError(CODES.SETTLEMENT_UNKNOWN_AUTH,
        `settlement ${evt.id} references ${evt.authId}, which has no authorization on ${acct.id}; no funds moved`);
    }
    if (auth.state === 'DECLINED') {
      throw new LedgerError(CODES.SETTLEMENT_AUTH_DECLINED, `${evt.authId} was declined; no funds moved`);
    }
    if (auth.state === 'SETTLED') {
      throw new LedgerError(CODES.SETTLEMENT_AUTH_ALREADY_SETTLED, `${evt.authId} already settled by ${auth.settledBy}`);
    }
    const ceiling = auth.amount + Math.floor(auth.amount * this.policy.settlementOverToleranceBps / 10_000);
    if (amt > ceiling) {
      throw new LedgerError(CODES.SETTLEMENT_EXCEEDS_AUTH,
        `settles ${money.format(amt, acct.currency)} against hold ${money.format(auth.amount, acct.currency)}`);
    }
    this._canPost(acct, evt.valueDate, -amt);
    const released = Math.max(0, auth.amount - amt);
    const party = evt.counterparty ?? auth.counterparty;
    acct.holds = money.safe(acct.holds - auth.amount);
    const e = this._post(acct, { entryId: evt.id, eventId: evt.id, kind: 'SETTLEMENT', direction: 'DEBIT', amount: amt,
      postingDate: evt.day, valueDate: evt.valueDate, authId: evt.authId, counterparty: party,
      story: `Settlement ${evt.id} of ${evt.authId} (hold ${this._fmt(acct, auth.amount)} approved D${auth.requestedDay} via `
        + `${auth.eventId}; ${released > 0 ? `${this._fmt(acct, released)} of the hold released` : 'hold fully used'})` });
    this._refer(acct, new Ref(evt.id, 'SETTLEMENT', 'DEBIT', amt, evt.valueDate, evt.day, null, party, null, null));
    auth.state = 'SETTLED';
    auth.settledAmount = amt;
    auth.releasedAmount = released;
    auth.settledBy = evt.id;
    auth.history.push(Object.freeze({ day: this.openDay, state: 'SETTLED', eventId: evt.id }));
    return { outcome: released > 0 ? 'SETTLED_PARTIAL_HOLD_RELEASED' : 'SETTLED', narration: e.narration };
  }

  _target(evt, acct, allowed) {
    const t = acct.ids && acct.ids.get(evt.ref);
    if (!(t instanceof Ref)) throw new LedgerError(CODES.REFERENCE_NOT_FOUND, `${evt.ref} not found on ${acct.id}`);
    if (!allowed.has(t.kind)) {
      throw new LedgerError(CODES.REFERENCE_NOT_ELIGIBLE, `${evt.type} cannot target a ${t.kind} (${evt.ref})`);
    }
    if (t.reversedBy) throw new LedgerError(CODES.ALREADY_REVERSED, `${evt.ref} already reversed by ${t.reversedBy}`);
    if (evt.valueDate < t.valueDate) {
      throw new LedgerError(CODES.VALUE_DATE_BEFORE_ORIGINAL,
        `value D${evt.valueDate} precedes ${evt.ref}'s value D${t.valueDate}`);
    }
    return t;
  }

  _origText(acct, t) {
    return `${t.direction} ${this._fmt(acct, t.amount)}, posted D${t.postingDate}, value D${t.valueDate}`;
  }

  /** Full reversal: one opposite-direction entry per original entry. The original is untouched. */
  _reverse(evt, acct) {
    const t = this._target(evt, acct, REVERSIBLE);
    if (t.consumed > 0) {
      throw new LedgerError(CODES.REVERSAL_AFTER_PARTIAL_REFUND,
        `${evt.ref} already has ${money.format(t.consumed, acct.currency)} returned/refunded; reverse the remainder with REFUND`);
    }
    if (evt.amount !== null && money.parseAmount(evt.amount, acct.currency) !== t.amount) {
      throw new LedgerError(CODES.REVERSAL_AMOUNT_MISMATCH, 'a reversal is always for the full original amount');
    }
    const dir = OPPOSITE[t.direction];
    const vatAmt = t.vat ? t.vat.amount - t.vat.refunded : 0;
    this._canPost(acct, evt.valueDate, (dir === 'CREDIT' ? 1 : -1) * t.amount + vatAmt);
    const narr = [];
    for (let i = 0; i < t.partCount; i++) {
      const e = this._post(acct, { entryId: t.parts ? `${evt.id}#${i + 1}` : evt.id, eventId: evt.id,
        kind: 'REVERSAL', direction: dir, amount: t.part(i), postingDate: evt.day, valueDate: evt.valueDate,
        refersTo: t.entryId(i), counterparty: t.counterparty, transferId: t.transferId,
        story: `Reversal ${evt.id} of ${t.entryId(i)} (original ${this._origText(acct, t)}; original entry kept, this is a separate ${dir} entry)` });
      narr.push(e.narration);
    }
    if (vatAmt > 0) {
      const e = this._post(acct, { entryId: `VAT:${evt.id}`, eventId: evt.id, kind: 'VAT_REVERSAL', direction: 'CREDIT',
        amount: vatAmt, postingDate: evt.day, valueDate: evt.valueDate, refersTo: t.vat.entryId,
        counterparty: this.policy.bank.gl.VAT_PAYABLE, story: `VAT reversal ${evt.id} of ${t.vat.entryId}` });
      narr.push(e.narration);
      t.vat.refunded += vatAmt;
    }
    t.reversedBy = evt.id;
    t.consumed = t.amount;
    return { outcome: 'REVERSED', narration: narr.join(' | ') };
  }

  /** RETURN (merchandise) or REFUND (any debit incl. fees/charges): separate credit entries, partial allowed. */
  _refund(evt, acct) {
    const t = this._target(evt, acct, evt.type === 'RETURN' ? RETURNABLE : REFUNDABLE);
    const remaining = t.amount - t.consumed;
    const amt = evt.amount === null ? remaining : this._amount(evt, acct);
    if (amt <= 0 || amt > remaining) {
      throw new LedgerError(CODES.REFUND_EXCEEDS_REMAINING,
        `${evt.type} ${money.format(amt, acct.currency)} exceeds remaining ${money.format(remaining, acct.currency)} on ${evt.ref}`);
    }
    let vatBack = 0;
    if (t.vat) {
      const vatRemaining = t.vat.amount - t.vat.refunded;
      vatBack = amt === remaining ? vatRemaining
        : Math.min(vatRemaining, money.divRoundHalfEven(money.safe(t.vat.amount * amt), t.amount));
    }
    this._canPost(acct, evt.valueDate, amt + vatBack);
    const label = evt.type === 'RETURN' ? 'Return' : 'Refund';
    const left = remaining - amt;
    const narr = [];
    const e = this._post(acct, { entryId: evt.id, eventId: evt.id, kind: evt.type, direction: 'CREDIT', amount: amt,
      postingDate: evt.day, valueDate: evt.valueDate, refersTo: t.entryId(0), counterparty: t.counterparty,
      transferId: t.transferId,
      story: `${label} ${evt.id} against ${t.kind} ${t.entryId(0)} (original ${this._origText(acct, t)}); `
        + `${left === 0 ? 'fully' : 'partially'} refunded, ${this._fmt(acct, left)} remaining` });
    narr.push(e.narration);
    if (vatBack > 0) {
      const v = this._post(acct, { entryId: `VAT:${evt.id}`, eventId: evt.id, kind: 'VAT_REFUND', direction: 'CREDIT',
        amount: vatBack, postingDate: evt.day, valueDate: evt.valueDate, refersTo: t.vat.entryId,
        counterparty: this.policy.bank.gl.VAT_PAYABLE, story: `VAT refund ${evt.id} on ${t.vat.entryId}, separate entry` });
      narr.push(v.narration);
      t.vat.refunded += vatBack;
    }
    t.consumed += amt;
    return { outcome: t.consumed === t.amount ? `${evt.type}_FULL` : `${evt.type}_PARTIAL`, narration: narr.join(' | ') };
  }

  _refer(acct, ref) {
    if (acct.ids === null) acct.ids = new Map();
    acct.ids.set(ref.id, ref);
  }

  /** The only place a ledger entry is created. */
  _post(acct, e) {
    const signed = e.direction === 'CREDIT' ? e.amount : -e.amount;
    if (!(e.amount > 0)) throw new InvariantError(`non-positive entry amount ${e.amount}`);
    const from = e.direction === 'CREDIT' ? (e.counterparty ?? null) : acct.party;
    const to = e.direction === 'CREDIT' ? acct.party : (e.counterparty ?? null);
    const back = e.postingDate - e.valueDate;
    const narration = flat(`${e.story}; ${e.direction} ${this._fmt(acct, e.amount)} from ${partyText(from)} to ${partyText(to)}`
      + `; posted D${e.postingDate}, value D${e.valueDate}${back > 0 ? ` (back-valued ${back} day${back > 1 ? 's' : ''})` : ''}`
      + `${this.openDay > e.postingDate ? `; arrived late, processed D${this.openDay}` : ''}`);
    const entry = Object.freeze({
      entryId: e.entryId,
      eventId: e.eventId ?? null,
      account: acct.id,
      currency: acct.currency,
      kind: e.kind,
      direction: e.direction,
      amount: e.amount,
      postingDate: e.postingDate,
      valueDate: e.valueDate,
      processedOnDay: this.openDay,
      refersTo: e.refersTo ?? null,
      authId: e.authId ?? null,
      instalment: e.instalment ?? null,
      transferId: e.transferId ?? null,
      from,
      to,
      narration,
    });
    acct.book = money.safe(acct.book + signed);
    acct.p(F_DELTA, e.valueDate, money.safe(acct.g(F_DELTA, e.valueDate) + signed));
    if (e.valueDate <= acct.closedThrough) {
      if (e.valueDate < acct.dirtyFrom) acct.dirtyFrom = e.valueDate;
      if (e.eventId) (acct.dirtyBy || (acct.dirtyBy = [])).push(e.eventId);
    }
    if (this.retainJournal) this.journal.push(entry);
    this.journalCount++;
    if (this.detail) (acct.today || (acct.today = [])).push(entry);
    return entry;
  }

  _log(seq, eventId, type, account, postingDate, status, code, outcome, narration) {
    this.eventLog.push(Object.freeze({ seq, eventId, type: type ?? null, account, postingDate: postingDate ?? null,
      processedOnDay: this.openDay, status, code, outcome, narration }));
  }

  _reject(seq, eventId, type, account, day, code, message) {
    const narration = flat(`${type ?? 'Event'} ${eventId ?? '(no id)'}${account ? ` on ${account}` : ''} REJECTED `
      + `(${code}): ${message}; ledger unchanged; processed D${this.openDay}`);
    this._log(seq, eventId, type, account, Number.isSafeInteger(day) ? day : null, 'REJECTED', code, null, narration);
    this.stats.rejected++;
    this.errorTotal++;
    this.errorCounts[code] = (this.errorCounts[code] || 0) + 1;
    if (this.errors.length < this.errorSampleLimit) {
      this.errors.push({ seq, eventId, account, code, message });
    }
  }

  // ─────────────────────────────── day close ────────────────────────────────

  /**
   * Close value day D (must be the open day). For every account:
   *  1. Re-run value days from the earliest touched one to D. Assess the overdraft
   *     fee for any day whose closing balance is negative and that has no fee yet
   *     (value date = that day, posting date = D). Record restatements.
   *  2. Recompute interest with a carried rounding remainder (see NUMBERS.md):
   *     rounded cumulative accrual R(v) = halfEven(Σ max(0,closing) × 4 / 10000);
   *     the day's accrual is R(v) − R(v−1). When the target for a day changes,
   *     post an adjusting accrual record for the difference. Nothing is overwritten.
   *  3. On the capitalization day, credit Σ accrual records as one INTEREST entry.
   */
  closeDay(D) {
    if (this.windowClosed) throw new InvariantError('closeDay after window closed');
    if (D !== this.openDay) throw new InvariantError(`closeDay(${D}) but open day is ${this.openDay}`);
    const { num: rNum, den: rDen } = this.policy.interestRate;
    const capDay = this.policy.capitalizeOnDay;
    const gl = this.policy.bank.gl;
    const totals = Object.create(null);
    const accountsOut = this.detail ? [] : null;

    for (const acct of this.accounts.values()) {
      const start = Math.min(acct.dirtyFrom, D);
      const trigger = acct.dirtyBy ? [...new Set(acct.dirtyBy)].join(', ') : null;
      const fees = [];
      const accr = [];
      const restated = [];
      let running = acct.g(F_CLOSING, start - 1);

      for (let v = start; v <= D; v++) {
        const before = v <= acct.closedThrough ? acct.g(F_CLOSING, v) : null;
        running = money.safe(running + acct.g(F_DELTA, v));
        acct.p(F_PREFEE, v, running);
        let feeNow = false;
        if (running < 0 && acct.g(F_FEE, v) === 0) {
          const fee = this.feeMinor[acct.currency];
          if (fee === undefined) {
            acct.p(F_FEE, v, 2);
            this._reject(null, null, 'FEE', acct.id, D, CODES.FEE_NOT_CONFIGURED,
              `D${v} closed at ${money.format(running, acct.currency)} but no overdraft fee is configured for ${acct.currency}`);
          } else {
            const vat = this._vatOn(acct, fee);
            const feeId = `FEE:${acct.id}:D${v}`;
            const why = v < D
              ? `recomputed at D${D} close${trigger ? ` after back-valued ${trigger}` : ''}`
              : `at D${D} close`;
            this._post(acct, { entryId: feeId, eventId: null, kind: 'FEE', direction: 'DEBIT', amount: fee,
              postingDate: D, valueDate: v, counterparty: gl.FEE_INCOME,
              story: `Overdraft fee for value D${v}: D${v} closing balance ${this._fmt(acct, running)} ${why}` });
            let vatRef = null;
            if (vat > 0) {
              vatRef = { entryId: `VAT:${feeId}`, amount: vat, refunded: 0 };
              this._post(acct, { entryId: vatRef.entryId, eventId: null, kind: 'VAT', direction: 'DEBIT', amount: vat,
                postingDate: D, valueDate: v, refersTo: feeId, counterparty: gl.VAT_PAYABLE,
                story: `VAT ${this._vatBps(acct) / 100}% on overdraft fee ${feeId}, separate entry` });
            }
            this._refer(acct, new Ref(feeId, 'FEE', 'DEBIT', fee, v, D, null, gl.FEE_INCOME, null, vatRef));
            acct.p(F_FEE, v, 1);
            feeNow = true;
            running = money.safe(running - fee - vat);
            fees.push({ entryId: feeId, valueDate: v, postingDate: D, amount: fee, vat, preFeeBalance: acct.g(F_PREFEE, v) });
          }
        }
        acct.p(F_CLOSING, v, running);
        if (before !== null && before !== running) {
          restated.push({ valueDate: v, before, preFee: acct.g(F_PREFEE, v), after: running, feeAssessedNow: feeNow });
        }

        // interest with carried remainder
        const cum = money.safe(acct.g(F_CUMNUM, v - 1) + Math.max(0, running) * rNum);
        acct.p(F_CUMNUM, v, cum);
        const target = money.divRoundHalfEven(cum, rDen) - money.divRoundHalfEven(acct.g(F_CUMNUM, v - 1), rDen);
        const posted = acct.g(F_ACCRUED, v);
        if (target !== posted) {
          const diff = target - posted;
          const isAdj = v <= acct.closedThrough;
          const rec = Object.freeze({
            accrualId: `ACR:${acct.id}:D${v}:${acct.accrualRecords + 1}`, account: acct.id, currency: acct.currency,
            valueDate: v, postingDate: D, amount: diff,
            kind: isAdj ? 'ACCRUAL_ADJUSTMENT' : 'ACCRUAL',
            exactCumulative: `${cum}/${rDen}`,
            narration: `${isAdj ? 'Accrual adjustment' : 'Daily accrual'} for value D${v}: closing `
              + `${this._fmt(acct, running)} × ${rNum}/${rDen}; cumulative exact ${cum}/${rDen} minor units → `
              + `day's rounded share ${target}${isAdj ? `, previously ${posted}, adjusting ${diff > 0 ? '+' : ''}${diff}` : ''}`
              + `; posted D${D}`,
          });
          // (accrual narrations are few: at most one per account per day, so they are not flattened)
          this.accruals.push(rec);
          acct.accrualSum = money.safe(acct.accrualSum + diff);
          acct.accrualRecords++;
          if (isAdj) acct.accrualAdjustments++;
          acct.p(F_ACCRUED, v, target);
          accr.push(rec);
        } else if (v === D && acct.closedThrough < D && target === 0 && this.detail) {
          accr.push({ valueDate: v, postingDate: D, amount: 0, kind: 'ACCRUAL' });
        }
      }
      acct.closedThrough = D;
      acct.dirtyFrom = Infinity;
      acct.dirtyBy = null;

      let accruedToDate = 0;
      for (let v = 1; v <= D; v++) accruedToDate += acct.g(F_ACCRUED, v);
      if (accruedToDate !== acct.accrualSum) {
        throw new InvariantError(`accrual drift on ${acct.id}: days ${accruedToDate} vs records ${acct.accrualSum}`);
      }

      let capitalized = null;
      if (D === capDay) {
        capitalized = acct.accrualSum;
        if (capitalized > 0) {
          const preCap = acct.g(F_CLOSING, D);
          this._post(acct, { entryId: `INT:${acct.id}:D${D}`, eventId: null, kind: 'INTEREST', direction: 'CREDIT',
            amount: capitalized, postingDate: D, valueDate: D, counterparty: gl.INTEREST_EXPENSE,
            story: `Interest capitalization D${this.firstDay}–D${D}: ${acct.accrualRecords} accrual records `
              + `(${acct.accrualAdjustments} back-value adjustment${acct.accrualAdjustments === 1 ? "" : "s"}) sum exactly to ${this._fmt(acct, capitalized)}; `
              + `rate ${rNum}/${rDen} per day on positive closing balances` });
          acct.p(F_CLOSING, D, money.safe(preCap + capitalized));
          acct.p(F_PREFEE, D, money.safe(acct.g(F_PREFEE, D) + capitalized));
          acct.dirtyFrom = Infinity; // posted inside the closed day; nothing downstream to restate
          acct.dirtyBy = null;
        }
        acct.capitalized = capitalized;
      }

      const closing = acct.g(F_CLOSING, D);
      const t = totals[acct.currency] || (totals[acct.currency] = {
        accounts: 0, closing: 0, negativeAccounts: 0, fees: 0, feeCount: 0, vat: 0, accrualNet: 0, capitalized: 0, holds: 0 });
      t.accounts++;
      t.closing = money.safe(t.closing + closing);
      if (closing < 0) t.negativeAccounts++;
      for (const f of fees) { t.fees += f.amount; t.vat += f.vat; t.feeCount++; }
      for (const a of accr) t.accrualNet += a.amount;
      if (capitalized) t.capitalized += capitalized;
      t.holds += acct.holds;

      if (this.detail) {
        const auths = [];
        for (const a of (acct.auths ? acct.auths.values() : [])) {
          auths.push({ authId: a.authId, eventId: a.eventId, state: a.state, amount: a.amount,
            requestedDay: a.requestedDay, availableAfter: a.availableAfter, settledAmount: a.settledAmount,
            releasedAmount: a.releasedAmount, settledBy: a.settledBy,
            changedToday: a.history.some((h) => h.day === D) });
        }
        accountsOut.push({
          account: acct.id, currency: acct.currency, party: acct.party, closing,
          preCapitalization: capitalized ? closing - capitalized : null,
          holds: acct.holds, available: money.safe(acct.book - acct.holds),
          fees, accruals: accr, accruedToDate: acct.accrualSum, restated, capitalized, auths,
          entries: acct.today ? acct.today.slice() : [],
          valueDayBalances: Array.from({ length: D }, (_, i) => acct.g(F_CLOSING, i + 1)),
        });
      }
      acct.today = null;
    }

    const report = {
      day: D,
      accounts: accountsOut,
      totals,
      errors: this.errors,
      errorCounts: this.errorCounts,
      errorTotal: this.errorTotal,
      notices: this.notices,
      stats: this.stats,
    };
    this._resetDay();
    this.openDay = D + 1;
    if (D === this.lastDay) this.windowClosed = true;
    return report;
  }

  // ──────────────────────────────── queries ─────────────────────────────────

  /** Closing ledger balance of value day v as currently known (after fees). */
  closingBalance(accountId, v) { return this._acct(accountId).g(F_CLOSING, v); }

  /** Balance of value day v recomputed from the journal alone (audit path; optionally excluding kinds). */
  balanceFromJournal(accountId, v, { excludeKinds = [] } = {}) {
    const acct = this._acct(accountId);
    let b = acct.g(F_DELTA, 0);
    const ex = new Set(excludeKinds);
    for (const e of this.journal) {
      if (e.account !== accountId || e.valueDate > v || ex.has(e.kind)) continue;
      b += e.direction === 'CREDIT' ? e.amount : -e.amount;
    }
    return b;
  }

  available(accountId) { const a = this._acct(accountId); return a.book - a.holds; }
  bookBalance(accountId) { return this._acct(accountId).book; }
  auth(accountId, authId) {
    const auths = this._acct(accountId).auths;
    const a = auths && auths.get(authId);
    return a ? { ...a, history: [...a.history] } : null;
  }
  accrualSum(accountId) { return this._acct(accountId).accrualSum; }

  _acct(id) {
    const a = this.accounts.get(id);
    if (!a) throw new LedgerError(CODES.UNKNOWN_ACCOUNT, `unknown account ${id}`);
    return a;
  }
}

module.exports = { LedgerShard, partyText };
