/**
 * Per-account ledger view for queries (the HTTP endpoint). Read-only: it
 * reads the shard's append-only journal, accrual sub-ledger and event log,
 * and never changes them.
 *
 * Money in the output is a decimal string in major units ("620.00", "-3.334"),
 * the same format events are written in, so no consumer ever has to handle a
 * float. Debits and credits are listed separately and never netted.
 */
import { currencyInfo, toDecimal } from './money';
import type { LedgerShard } from './shard';
import type { AccrualRecord, AuthState, Direction, EntryKind, EventLogRecord, JournalEntry, Party } from './types';

export interface LedgerEntryView {
  entryId: string;
  eventId: string | null;
  kind: EntryKind;
  direction: Direction;
  debit: string | null;
  credit: string | null;
  /** Book balance after this entry, in processing order. */
  balanceAfter: string;
  postingDate: number;
  valueDate: number;
  processedOnDay: number;
  refersTo: string | null;
  authId: string | null;
  instalment: string | null;
  transferId: string | null;
  from: Party | null;
  to: Party | null;
  narration: string;
}

export interface AccountLedger {
  account: {
    accountNumber: string;
    accountName: string | null;
    bankName: string | null;
    bic: string | null;
    iban: string | null;
    currency: string;
    minorUnits: number;
  };
  window: { firstDay: number; lastDay: number; closedThroughDay: number; windowClosed: boolean };
  balances: {
    opening: string;
    closing: string;
    activeHolds: string;
    available: string;
    interestAccrued: string;
    interestCapitalized: string | null;
  };
  totals: { entries: number; debits: string; credits: string; netMovement: string };
  entries: LedgerEntryView[];
  valueDayBalances: { valueDate: number; closingBalance: string }[];
  interestAccruals: {
    accrualId: string; kind: AccrualRecord['kind']; valueDate: number; postingDate: number;
    amount: string; exactCumulative: string; narration: string;
  }[];
  authorizations: {
    authId: string; eventId: string; state: AuthState; amount: string; requestedDay: number;
    settledAmount: string; releasedAmount: string; settledBy: string | null;
    history: { day: number; state: AuthState; eventId: string }[];
  }[];
  rejectedEvents: { seq: number | null; eventId: string | null; type: string | null; postingDate: number | null;
    processedOnDay: number; code: string | null; narration: string }[];
}

/**
 * Indexes a shard's records by account once, so each lookup is proportional
 * to that account's history rather than the whole journal. Build it after the
 * replay has finished: records appended later are not in the index.
 */
export class AccountLedgerIndex {
  private readonly entries = new Map<string, JournalEntry[]>();
  private readonly accruals = new Map<string, AccrualRecord[]>();
  private readonly events = new Map<string, EventLogRecord[]>();

  constructor(private readonly shard: LedgerShard) {
    if (!shard.retainJournal) throw new Error('account ledger needs a shard that retains its journal');
    for (const e of shard.journal) push(this.entries, e.account, e);
    for (const a of shard.accruals) push(this.accruals, a.account, a);
    for (const l of shard.eventLog) if (l.account !== null) push(this.events, l.account, l);
  }

  has(accountNumber: string): boolean { return this.shard.hasAccount(accountNumber); }

  /** The full ledger for one account, or null if the account does not exist. */
  ledger(accountNumber: string): AccountLedger | null {
    if (!this.shard.hasAccount(accountNumber)) return null;
    const snap = this.shard.snapshot(accountNumber);
    const c = snap.currency;
    const dec = (minor: number): string => toDecimal(minor, c);

    let running = snap.opening;
    let debits = 0;
    let credits = 0;
    const entries = (this.entries.get(accountNumber) ?? []).map((e): LedgerEntryView => {
      const isDebit = e.direction === 'DEBIT';
      if (isDebit) debits += e.amount; else credits += e.amount;
      running += isDebit ? -e.amount : e.amount;
      return {
        entryId: e.entryId, eventId: e.eventId, kind: e.kind, direction: e.direction,
        debit: isDebit ? dec(e.amount) : null, credit: isDebit ? null : dec(e.amount), balanceAfter: dec(running),
        postingDate: e.postingDate, valueDate: e.valueDate, processedOnDay: e.processedOnDay,
        refersTo: e.refersTo, authId: e.authId, instalment: e.instalment, transferId: e.transferId,
        from: e.from, to: e.to, narration: e.narration,
      };
    });

    return {
      account: {
        accountNumber: snap.account, accountName: snap.party.accountName ?? null, bankName: snap.party.bankName ?? null,
        bic: snap.party.bic ?? null, iban: snap.party.iban ?? null, currency: c, minorUnits: currencyInfo(c).precision,
      },
      window: { firstDay: this.shard.firstDay, lastDay: this.shard.lastDay, closedThroughDay: snap.closedThrough,
        windowClosed: this.shard.windowClosed },
      balances: {
        opening: dec(snap.opening), closing: dec(snap.book), activeHolds: dec(snap.holds), available: dec(snap.available),
        interestAccrued: dec(snap.accrualSum), interestCapitalized: snap.capitalized === null ? null : dec(snap.capitalized),
      },
      totals: { entries: entries.length, debits: dec(debits), credits: dec(credits), netMovement: dec(credits - debits) },
      entries,
      valueDayBalances: snap.valueDayBalances.map((b, i) => ({ valueDate: i + 1, closingBalance: dec(b) })),
      interestAccruals: (this.accruals.get(accountNumber) ?? []).map((a) => ({
        accrualId: a.accrualId, kind: a.kind, valueDate: a.valueDate, postingDate: a.postingDate,
        amount: dec(a.amount), exactCumulative: a.exactCumulative, narration: a.narration,
      })),
      authorizations: snap.auths.map((a) => ({
        authId: a.authId, eventId: a.eventId, state: a.state, amount: dec(a.amount), requestedDay: a.requestedDay,
        settledAmount: dec(a.settledAmount), releasedAmount: dec(a.releasedAmount), settledBy: a.settledBy,
        history: a.history.map((h) => ({ ...h })),
      })),
      rejectedEvents: (this.events.get(accountNumber) ?? []).filter((l) => l.status === 'REJECTED').map((l) => ({
        seq: l.seq, eventId: l.eventId, type: l.type, postingDate: l.postingDate, processedOnDay: l.processedOnDay,
        code: l.code, narration: l.narration,
      })),
    };
  }
}

function push<T>(m: Map<string, T[]>, k: string, v: T): void {
  const list = m.get(k);
  if (list) list.push(v); else m.set(k, [v]);
}
