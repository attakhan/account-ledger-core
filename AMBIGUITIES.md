# AMBIGUITIES

Each entry gives: what the brief (or the user's addenda) leaves open, what I decided, why, and where it
shows in the code or tests. "Brief" means the original task statement. "Addendum" means one of the user's
follow-up messages during the build.

---

## Time, ordering and dates

### A1 — What the "Day N" on each event means
**Ambiguity.** Each event has a day (for example "E7 — Day 5") and a `value_date`. The brief never names
the first one.

**Decision.** It is the **posting date**: the day the event reached the ledger. Per the addendum, it is
fixed at the first arrival and never changed. A separate `processedOnDay` records which open day actually
processed the event. The two differ only for late arrivals (A3). Every journal entry therefore carries
three dates: `postingDate`, `valueDate` and `processedOnDay`.

### A2 — Do back-valued entries trigger fees on days that are already closed?
**Ambiguity.** "Assessed once per day … when that day's closing ledger balance (all entries with value_date
≤ that day) is negative."

**Decision.** Yes. At each close the engine re-runs every value day from the earliest one touched since the
last close, and assesses a fee for any day that is now negative and has no fee yet. The fee has
`valueDate` = the day assessed and `postingDate` = the close that found it.

**Why.** The parenthetical defines the balance by value date, not by booking date. C1 ("evaluated at end of
Day 5 and before any fee is assessed") describes exactly this re-evaluation. A rule that ignored
back-valued entries would never need that parenthetical.

**Evidence.** `closeDay` in `src/shard.js`; the D5 report shows three fees.

### A3 — E10 is listed after E9 (Day 6) but stamped Day 5
**Ambiguity.** "Replayed in this order", but the stamped day goes backwards.

**Decision.** Honour the order. When E9 arrives the clock moves to D6, so D5 is already closed when E10
arrives. E10 is accepted as a **late arrival**:
- `postingDate` stays D5 and `processedOnDay` is D6;
- a `LATE_ARRIVAL` notice is raised;
- the D6 close restates D5 for ACC-002 (0.000 → 10.000) and posts a D5 accrual adjustment (+0.004).

**Rejected alternatives.**
- Sorting by day contradicts the brief.
- Rejecting a late credit would drop real money.

**Consequence.** The point-in-time D5 report shows ACC-002 at 0.000. The end-of-window restated table shows
10.000 for D5. Both are printed.

### A4 — Which "closing ledger balance" to print per day
**Decision.** Two views are printed, because a single number would mislead:
- **Point-in-time:** the balance as known at that day's close (D5: ACC-001 −230.00).
- **Restated:** after all later back-valued entries, printed as a table at the end of the window
  (D5: 390.00).

Restatements are listed under the day that discovered them.

### A5 — Window end and capitalization timing
**Decision.** "End of Day 6" runs in this order: D6 fee check → D6 accrual → capitalization credit (value
D6, posting D6).
- D6's own interest is computed on the balance **before** the capitalization credit. The other way round
  is circular.
- The printed D6 closing balance includes the credit, and the pre-capitalization figure is shown next to it.
- After the D6 close, any event is rejected with `WINDOW_CLOSED`.

### A6 — Future-dated and very old value dates
**Decision.**
- `valueDate > postingDate` → `VALUE_DATE_IN_FUTURE`. Nothing in the brief needs future dating, and it would
  make "available balance now" ambiguous.
- `valueDate` before D1 → `VALUE_DATE_TOO_OLD`.
- Back-valuation depth is unlimited inside the window (`maxBackValueDays: null`); see NUMBERS.

---

## Authorizations and settlements

### A7 — Should fees caused by a later-reversed posting be refunded?
**Ambiguity.** E9 fully reverses E7 at the same value date. In the final restated view, D2, D4 and D5 are
positive, yet three fees were assessed while E7 stood.

**Decision.** **No automatic refund.**
- The rule as given assesses fees. It says nothing about un-assessing or refunding them.
- An append-only ledger cannot delete them, and an auto-refund rule is a product decision the core should
  not invent. Open questions for that decision: only on reversals? on any restatement? on partial ones?
- The ledger *can* do it: `REFUND` of `FEE:<acct>:D<n>` posts a separate CREDIT, plus a separate
  VAT_REFUND if VAT applied.

**Evidence.** The known-failing test (`test/known-failing/fees-after-reversal.test.js`) states the
customer-fairness case, and shows that the outcome depends on arrival order.

### A8 — Settlement for an authorization that does not exist (E6 / Auth-Z)
**Decision.** Reject with `SETTLEMENT_UNKNOWN_AUTH`. No entry is posted and no funds move (C4 accepted).

**Caveat.** Real card clearing can arrive without an auth (offline, forced, expired and purged). Rejecting
at the ledger then leaves a scheme liability unrecorded. The fuller model is to post to a suspense account
and dispute. That needs a suspense/GL model the brief doesn't have.

Related rejections:
- a settlement against a **declined** auth → `SETTLEMENT_AUTH_DECLINED`;
- a second settlement → `SETTLEMENT_AUTH_ALREADY_SETTLED`.

### A9 — Partial and over-settlement
**Decision.**
- Settling for less than the hold (E5: 185.00 of 200.00) debits the settled amount and **releases the
  remainder**. The whole hold is removed and the auth is terminal. There is no multi-clearing.
- Settling for more than the hold → `SETTLEMENT_EXCEEDS_AUTH`. Tolerance is 0 bps (NUMBERS). Real
  merchants such as restaurants and fuel stations have tolerances, but the brief gives none.

### A10 — What "available balance" includes at authorization time
**Decision.** Available = ledger balance (every posted entry so far, fees included; no future-dated entries
exist) − active holds. Evaluated **when the auth is processed**, and never re-evaluated.

**Consequence for Auth-B.** E7 (posted D5) comes before E8 in the stream, so ledger = −155.00 and available
after the hold = −245.00 → **DECLINED**. Had E8 come first, available would have been 465.00 − 90.00 =
375.00 → approved. The stream order decides.

### A11 — Do plain DEBITs need available funds?
**Decision.** No. Only authorizations are gated ("An authorization is approved only if…").
- E7 overdraws the account, which is the whole point of the fee rule.
- Reversals, charges and fees also post unconditionally.

### A12 — Hold expiry
**Decision.** Holds do not expire within the window. The brief says "Auth-B is never settled inside the
window" but gives no expiry. It is moot anyway: Auth-B is declined. Had it been approved, its 90.00 hold
would still be active at the end of D6. The README notes expiry as future work.

---

## Money and rounding

### A13 — "Amounts stored and rounded to their own precision" — rounded where?
**Decision.**
- **Inputs** with more decimals than the currency allows are **rejected** (`AMOUNT_PRECISION`), not
  rounded. Rounding an instruction moves money nobody instructed.
- Rounding happens only to amounts the ledger itself **computes**: interest, VAT and instalment splits.
- Each is rounded to its account's precision: AED 2 decimal places, BHD 3.

### A14 — Interest details the brief leaves open
**Decisions.**
- **Basis:** the value-day closing ledger balance, *after* that day's fee, positive days only (0 or
  negative accrues nothing).
- **No compounding within the window:** accrued-but-uncapitalized interest is not part of the balance.
- **Same rate for BHD and AED:** the brief states one rate.
- **Rounding:** half-even on the *cumulative* exact accrual. Each day's accrual is the difference of
  consecutive rounded cumulatives. Details and why in NUMBERS §3.
- **Back-valued changes:** they post `ACCRUAL_ADJUSTMENT` records (append-only) rather than rewriting a
  day's accrual.
- **Capitalized amount** = Σ of every accrual record, so "rounded daily accruals sum exactly to the
  capitalized total" holds by construction. It is checked at every close.

### A15 — Overdraft fee on the BHD account
**Ambiguity.** The fee is "AED 25.00 … per account", but ACC-002 is in BHD, and there is no FX rate.

**Decision.** Fees are configured per currency, and only AED has one. If a BHD day goes negative, the close
raises `FEE_NOT_CONFIGURED` (once per day), posts nothing, and does not invent a conversion. ACC-002 never
goes negative in the scenario. A unit test forces the case.

### A16 — Do fees count toward later days' balances, and can fees stack?
**Decision.** Yes on both.
- A fee is a ledger entry with value date D, so it lowers D and every later day. That is why D3 is +5.00
  and not +30.00. D3 stays fee-free either way.
- A day that is negative only because of earlier fees still gets a fee. The fee spiral is intended by the
  rule as written.
- A day at exactly 0.00 is not negative, so it gets no fee.

### A17 — The instalments in E10
**Decision.**
- Three separate journal entries (`E10#1..3`), all with posting D5 and value D5.
- Amounts by largest remainder: 3.334 / 3.333 / 3.333 (C7 rejected).
- One event ID for idempotency.
- Reversing E10 would post three mirrored entries.

---

## Records and identity

### A18 — Idempotency scope
**Decision.** Event IDs are unique **per account**. A second event with a seen ID →
`DUPLICATE_EVENT`, and the original's posting date stands (addendum).

**Consequence.** The same ID on two *different* accounts is accepted twice. A global ID set would
serialise the sharded router and cost memory; see REJECTED Part 2 item 10.

### A19 — Are rejected events' IDs "used up"?
**Decision.** Yes. An ID names one fact forever, so a corrected resend needs a new ID. This gives
deterministic replays: the same stream always yields the same outcome, whatever the retries.

### A20 — What "append-only / never mutated" covers
**Decision.** Three record stores are append-only and hold `Object.freeze`d records:
- the **event log** (every inbound event, accepted or rejected, with its narration);
- the **journal** (ledger entries);
- the **accrual sub-ledger**.

Per-account derived state does change: balances by value day, holds, auth status, refund tracking. It is an
index that could be rebuilt from the records, and `balanceFromJournal` verifies that in tests.

### A21 — Reversal / return / refund semantics (addendum: two separate entries)
**Decision.**
- **REVERSAL** is always the full amount, one mirrored entry per original entry, with `refersTo` the
  original. It is allowed on CREDIT, DEBIT, SETTLEMENT and CHARGE, and refused after any partial refund
  (`REVERSAL_AFTER_PARTIAL_REFUND`).
- **RETURN** applies to DEBIT or SETTLEMENT. Partial is allowed.
- **REFUND** applies to DEBIT, SETTLEMENT, FEE or CHARGE. The amount defaults to what remains.
- The total of all of these is capped at the original amount (`REFUND_EXCEEDS_REMAINING`).
- The value date must not precede the original's (`VALUE_DATE_BEFORE_ORIGINAL`).
- E9 carries no currency or amount; both are derived from E7.

### A22 — VAT on charges (addendum)
**Decision.** VAT is supported as a **separate** entry (kind `VAT`, counterparty GL-2300) on fees and
`CHARGE` events, refunded pro rata as a separate `VAT_REFUND`. The rate is **0 by default**:
- the brief fixes the fee at AED 25.00 and is "non-negotiable";
- adding 5% would change every required balance.

`--vat-bps 500` turns on UAE-style 5%. Whether a bank's overdraft fee is VAT-able in a given jurisdiction is
a tax question I have not settled here.

### A23 — From/to account information (addendum)
**Decision.**
- Every entry has `from` and `to` blocks with `accountNumber`, `accountName`, `bankName`, `bic` and `iban`.
- The own side comes from account master data. The other side comes from the event's `counterparty`, or
  from `from`/`to` in the event.
- Fees, VAT and interest use internal GL accounts of a fictional "Ledger Core Bank".
- Reversals and refunds flip the parties of the original.
- The scenario has no party data, so dummy values are used ("ACC1 Account Name", "E7 Payee Bank"…), as the
  user allowed. A settlement with no counterparty inherits its authorization's.

### A24 — Narration (addendum: "complete journey")
**Decision.** One line per entry and per event-log record. It covers:
- what happened, the amount, from → to, posting vs value date, back-valued days, and late processing;
- the links: which auth and how much hold was released; which original for a reversal or refund; which
  instalment;
- for a fee, which day's balance, at which close, and which back-valued event triggered the restatement;
- for an authorization, the available-balance arithmetic behind the decision.

Rejected events get a narration too.

### A25 — Transfers between two ledger accounts
**Decision.** Two legs (a DEBIT and a CREDIT) sharing a `transferId`, each naming the other account as
counterparty. They are not atomic; see REJECTED Part 2 item 5.

---

## Scale and operation

### A26 — What "large volume / large traffic" means with no web layer
**Decision.** The deliverable is a core plus a replayer, so "traffic" means event throughput and stream size.

What I built:
- a streaming NDJSON reader: memory does not scale with file size, only with retained records;
- account-sharded worker threads;
- bounded in-flight batches (backpressure);
- per-account lazy state;
- fail-stop on internal errors.

Measured on this 2-vCPU box: about 69–93k events/s, with 1M events costing about 2 GB RSS. The ceiling is
memory, because nothing is ever deleted and the user asked for a narration on every record. More cores were
not measured, so no numbers are claimed for them.

### A27 — Errors vs notices vs declines in the per-day output
**Decision.**
- **Errors** are rejections (the event had no ledger effect), plus `FEE_NOT_CONFIGURED`.
- **Notices** are accepted but notable: `BACK_VALUED`, `LATE_ARRIVAL`.
- A **declined authorization** is not an error. The event was processed correctly and the decision is
  shown under authorization states.

### A28 — Internal failures
**Decision.** Fail-stop.
- An `InvariantError` or any unexpected exception is logged as `INTERNAL_ERROR` and aborts the replay with
  exit code 1.
- A worker crash aborts the whole sharded replay.

Continuing on possibly inconsistent state is worse than stopping, and there is no persistence to recover
from.

### A29 — Opening balances
**Decision.** Held as value day 0 (not a journal entry), shown on statements. Both are 0 in the scenario.
Negative opening balances are accepted; that is master data, not an instruction.
