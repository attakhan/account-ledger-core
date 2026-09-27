# Account Ledger Core

This is an in-memory ledger core written in Node.js. It keeps an append-only record of every event and
every ledger entry. It handles value-dated fees, interest that accrues daily and is capitalized once,
card authorizations and settlements, and reversals, returns and refunds. Each of these produces its own
separate journal entry, with from/to party details and a narration line. Accounts can be split across
worker threads to process large event streams.

There is no web layer, no persistence, no UI and no database, and there are no npm dependencies. It needs
Node ≥ 20 (developed on 22).

```bash
npm test                   # 48 tests — must pass
npm run replay             # the brief's 10-event, 6-day scenario, printed per day
npm run replay:sharded     # same stream across 2 worker threads — identical output
npm run test:known-failing # the one deliberately failing test (see below)
npm run bench              # generates 1M events / 100k accounts and measures throughput
```

## Repository map

| Path | What |
|---|---|
| `src/shard.js` | The engine: validation → posting → day close (fees, interest, restatement). One instance per shard. |
| `src/money.js` | Integer minor-unit money: parse, format, half-even division, exact allocation. |
| `src/events.js` | Structural validation of inbound events. |
| `src/replay.js` | Streaming NDJSON replayer that drives the day clock. |
| `src/sharded.js`, `src/worker.js` | Worker-thread sharding by account, with backpressure and a day-close barrier. |
| `src/report.js`, `src/merge.js` | Deterministic merging of shard reports and rendering to text. |
| `bin/replay.js` | The CLI. |
| `data/scenario.ndjson`, `data/accounts.json` | The brief's event stream and accounts (dummy party data). |
| `data/transfer-example.*` | A two-leg transfer, a charge with VAT, and charge and fee refunds. |
| `scripts/gen-load.js`, `scripts/bench.js` | Synthetic load and the benchmark. |
| `scripts/bench-numeric.js` | The measurement behind the Number-vs-BigInt decision. |
| `test/unit`, `test/scenario` | The passing suite. |
| `test/known-failing` | The one failing test. |
| `NUMBERS.md`, `AMBIGUITIES.md`, `REJECTED.md`, `WORKLOG.md` | The required write-ups. |

## Running the replay

```bash
node bin/replay.js [events.ndjson] [--accounts file.json] [--shards N]
                   [--summary | --detail] [--json] [--vat-bps N] [--quiet] [--no-journal-retention]
```

With no arguments it replays `data/scenario.ndjson` against `data/accounts.json` in-process.

Options:
- `--shards N` runs N worker threads. The output is byte-identical to in-process, and a test checks this.
- `--json` emits the machine-readable reports.
- `--vat-bps 500` turns on a 5% VAT, posted as separate entries. It is off by default, because the brief
  fixes the fee at AED 25.00.
- `--summary` / `--detail` force the report style. By default, per-account detail is printed only up to
  50 accounts, and totals per currency are printed above that.

Exit codes:
- **0** — the replay completed. Business rejections are normal output, not failures.
- **1** — fatal: an unreadable file, a worker crash, or an internal invariant break (fail-stop).
- **2** — bad usage.

### Reading the output

Each day prints a block like this (abridged Day 5):

```
════════════════════════ DAY 5 CLOSE ════════════════════════
Events processed during D5: 2 accepted, 0 rejected
  ACC-001 (AED) — ACC1 Account Name, ACC1 Bank Name
    Closing ledger balance D5: -230.00   | active holds 0.00 | available -230.00
    Restated earlier days (back-valued postings):
      D2: was 250.00 → -370.00 before fee → now -395.00 after fee
      D3: was 650.00 → now 5.00
      D4: was 465.00 → -180.00 before fee → now -205.00 after fee
    Fee assessments (3):
      FEE:ACC-001:D2  DEBIT 25.00  value D2, posted D5  (day balance before fee -370.00)
      ...
    Interest accrual records (accrued to date 0.10):
      value D2 ACCRUAL_ADJUSTMENT -0.10   ...
    Authorizations:
      Auth-A (E3) SETTLED  hold 200.00 requested D2 — settled 185.00 by E5, released 15.00
      Auth-B (E8) DECLINED hold 90.00 requested D5 — available after hold would be -245.00  [changed today]
    Journal entries processed today (4):
      E7   DEBIT  DEBIT  620.00  posted D5 value D2 processed D5
        from: ACC-001 / ACC1 Account Name / ACC1 Bank Name
        to:   EXT-E7-PAYEE / E7 Payee Name / E7 Payee Bank
        narration: Debit E7; DEBIT AED 620.00 from ACC-001 (...) to EXT-E7-PAYEE (...); posted D5, value D2 (back-valued 3 days)
  Errors: none
  Notices (1):
    [seq 7] E7 ACC-001 BACK_VALUED: value D2 earlier than posting D5; days D2+ restated at close
```

What each part means:
- **Closing ledger balance** is the balance of that value day as known at that close, after any fee.
  Available = ledger − active holds. On D6 the pre-capitalization figure is also shown.
- **Restated earlier days** appear when a back-valued entry changes days that were already closed. This is
  how E7 (posted D5, value D2) and E9 (posted D6, value D2) show up.
- **Fee assessments** are the fees assessed *at this close*. A fee's value date is the day it is for. Its
  posting date is the close that found it.
- **Interest accrual records** form an append-only sub-ledger. Back-valued changes post adjustments rather
  than overwriting earlier records.
- **Authorizations** shows every auth on the account and its state. `[changed today]` marks the auths that
  moved during this day.
- **Errors** are rejected events (no ledger effect). **Notices** are accepted but notable events
  (back-valued, late arrival).

After D6 the replay prints two more sections:
- the **restated value-day balance table**: every day as finally known;
- an **account statement** for each account: every entry, with debits and credits in separate columns and
  never netted, plus opening and closing balances.

### Scenario results

| Day | ACC-001 closing | Available | Fees assessed at this close | Auths | ACC-002 | Errors |
|---|---|---|---|---|---|---|
| 1 | 250.00 | 250.00 | — | — | 0.000 | — |
| 2 | 250.00 | 50.00 | — | Auth-A APPROVED | 0.000 | — |
| 3 | 650.00 | 450.00 | — | Auth-A APPROVED | 0.000 | — |
| 4 | 465.00 | 465.00 | — | Auth-A SETTLED (185.00, 15.00 released) | 0.000 | E6 `SETTLEMENT_UNKNOWN_AUTH` |
| 5 | −230.00 | −230.00 | D2, D4, D5 (3 × 25.00) | Auth-B DECLINED | 0.000 | — |
| 6 | 390.92 (390.00 + 0.92 interest) | 390.92 | — | — | 10.008 (10.000 + 0.008) | — |

Final value-day balances for ACC-001, as restated after E9: 250.00 · 225.00 · 625.00 · 415.00 · 390.00 ·
390.92. The acceptance-criteria verdicts are in [REJECTED.md](REJECTED.md).

## Design in one page

- **Money.** Amounts are integer minor units (fils) held in JS Numbers, and every operation is checked with
  `Number.isSafeInteger`. Inputs are decimal strings: floats are refused, and extra decimals are rejected,
  not rounded. The only rounding is half-even on amounts the ledger computes itself.
- **Three append-only stores**, all holding frozen records:
  - the event log: every inbound event, accepted or rejected;
  - the journal: ledger entries;
  - the accrual sub-ledger.

  Everything else (balances by value day, holds, refund tracking) is a derived index that tests
  cross-check against the journal.
- **Dates.** Every entry carries three dates:
  - `postingDate`: the first arrival day, never changed;
  - `valueDate`: the day whose balance the entry affects;
  - `processedOnDay`: the day it was actually processed.
- **Day close.** For each account, the close re-runs value days from the earliest one touched since the
  last close. It assesses a fee for any newly negative day that has none yet, then recomputes interest with
  a carried rounding remainder, posting adjustments. On D6 it capitalizes Σ(accruals) as a single credit.
- **Separate entries.** Reversals, returns, refunds, charges, fees, VAT and interest are each their own
  entry, linked by `refersTo`. Nothing is netted or edited.
- **Parties and narration.** Every entry has `from`/`to` blocks (account number, name, bank, BIC, IBAN) and
  a one-line narration of the whole journey. System entries point at internal GL accounts (fee income, VAT
  payable, interest expense).
- **Scale.**
  - Input is streamed; memory grows only with retained records, not with file size.
  - Accounts are hash-partitioned across worker threads, which ship raw lines in 2048-event batches.
  - At most 8 batches are in flight per worker (backpressure).
  - Day close is a barrier, and reports are merged deterministically.
  - Internal errors are fail-stop.

  Measured on the 2-vCPU container: about 69–93k events/s at 1M events, about 2 GB RSS. NUMBERS.md has
  the table.

## Limits and trade-offs, stated plainly

- **Memory is the ceiling.** Nothing is ever deleted, and every record carries a narration, which costs
  about 2 KB per event at 1M events. Past a few million events per process you need more shards on more
  processes or machines, or real persistence. The brief rules persistence out.
- **Transfers between two ledger accounts are two non-atomic legs** sharing a `transferId`. An atomic
  version would need a two-phase commit between shards (REJECTED, Part 2, item 5).
- **Event-ID idempotency is scoped per account** (AMBIGUITIES A18).
- **Fees are never auto-refunded after a reversal.** This is the known-failing test (next section).
- **Holds do not expire.** Not needed within the 6-day window; it is the first thing to add for a longer
  one.
- **Scaling was measured on 2 vCPUs only.** I don't claim numbers for bigger machines.

## The failing test

`test/known-failing/fees-after-reversal.test.js` asserts that, by the end of the window, a customer does
not pay fees that exist only because of a posting the bank fully reversed at the same value date.

It fails: AED 75.00 remains. The file's inline comments explain what that reveals:
- the ledger is faithful to the rule, but the rule charges for an overdraft that no longer exists once the
  balance is restated;
- the fix is a policy decision, not arithmetic;
- the outcome depends on **arrival order**. A companion control test, which passes, shows zero fees when E9
  arrives before the D5 close.

`npm test` excludes this file. `npm run test:known-failing` and `npm run test:all` run it.

## Event format (NDJSON, one per line)

```json
{"id":"E7","day":5,"type":"DEBIT","account":"ACC-001","currency":"AED","amount":"620.00","valueDate":2,
 "counterparty":{"accountNumber":"EXT-E7-PAYEE","accountName":"E7 Payee Name","bankName":"E7 Payee Bank"}}
```

The fields are as follows. Everything except `day`, `valueDate` and `instalments` is a string.

- **All events:** `id`, `day`, `type`, `account`, plus an optional `valueDate` (defaults to `day`).
- **Event types:** `CREDIT` · `DEBIT` · `CHARGE` · `AUTHORIZATION` · `SETTLEMENT` · `REVERSAL` · `RETURN` ·
  `REFUND`.
- **Fields by type:**
  - `currency` and `amount` — required for money events, and optional on REVERSAL and REFUND;
  - `authId` — for AUTHORIZATION and SETTLEMENT;
  - `reverses` / `refersTo` — for REVERSAL, RETURN and REFUND. A fee is referenced as
    `FEE:<account>:D<n>`;
  - `instalments` — for CREDIT and DEBIT.
- **Optional on any event:** `counterparty` (or `from`/`to`) and `transferId`.
