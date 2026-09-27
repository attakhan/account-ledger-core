# Account Ledger Core

This is an in-memory ledger core written in TypeScript for Node.js. It keeps an append-only record of every event and
every ledger entry. It handles value-dated fees, interest that accrues daily and is capitalized once,
card authorizations and settlements, and reversals, returns and refunds. Each of these produces its own
separate journal entry, with from/to party details and a narration line. Accounts can be split across
worker threads to process large event streams.

The core has no persistence, no UI and no database. A small Express API (`npm run serve`) serves each
account's ledger as JSON and accepts new events, which it persists by appending to an NDJSON file. The only
runtime dependency is Express. TypeScript is compiled with `tsc` into `dist/`. Every npm script builds first.
It needs Node ≥ 20 (developed on 22).

```bash
npm install
npm test                   # 56 tests — must pass
npm run serve              # HTTP API on :3000 (see "HTTP API server" at the end)
npm run replay             # the brief's 10-event, 6-day scenario, printed per day
npm run replay:sharded     # same stream across 2 worker threads — identical output
npm run test:known-failing # the one deliberately failing test (see below)
npm run bench              # generates 1M events / 100k accounts and measures throughput
```

## Repository map

| Path | What |
|---|---|
| `src/types.ts` | Shared types: events, journal entries, reports, policy. |
| `src/shard.ts` | The engine: validation → posting → day close (fees, interest, restatement). One instance per shard. |
| `src/money.ts` | Integer minor-unit money: parse, format, half-even division, exact allocation. |
| `src/events.ts` | Structural validation of inbound events. |
| `src/replay.ts` | Streaming NDJSON replayer that drives the day clock. |
| `src/sharded.ts`, `src/worker.ts` | Worker-thread sharding by account, with backpressure and a day-close barrier. |
| `src/report.ts`, `src/merge.ts` | Deterministic merging of shard reports and rendering to text. |
| `src/account-ledger.ts` | Per-account ledger view (JSON) built from the journal. |
| `src/ledger-store.ts` | Persistent store: replays the events file, validates and appends new events. |
| `src/server.ts`, `bin/serve.ts` | The Express HTTP API and its CLI. |
| `bin/replay.ts` | The replay CLI. |
| `data/scenario.ndjson`, `data/accounts.json` | The brief's event stream and accounts (dummy party data). |
| `data/transfer-example.*` | A two-leg transfer, a charge with VAT, and charge and fee refunds. |
| `scripts/gen-load.ts`, `scripts/bench.ts` | Synthetic load and the benchmark. |
| `scripts/bench-numeric.ts` | The measurement behind the Number-vs-BigInt decision. |
| `test/unit`, `test/scenario`, `test/api` | The passing suite. |
| `test/known-failing` | The one failing test. |
| `NUMBERS.md`, `AMBIGUITIES.md`, `REJECTED.md`, `WORKLOG.md` | The required write-ups. |

## Running the replay

```bash
node dist/bin/replay.js [events.ndjson] [--accounts file.json] [--shards N]
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

`test/known-failing/fees-after-reversal.test.ts` asserts that, by the end of the window, a customer does
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

## HTTP API server (Express)

This addition sits on top of the ledger core above. It doesn't change the engine or the replay output.
It adds:
- `src/server.ts`: the Express app.
- `src/ledger-store.ts`: the persistent store behind it.
- `src/account-ledger.ts`: builds the per-account JSON.
- `bin/serve.ts`: the CLI that starts the server.

### Endpoints

| Method | Path | Result |
|---|---|---|
| `GET` | `/accounts/:accountNumber/ledger` | `200` the account's full ledger as JSON · `404` unknown account |
| `POST` | `/accounts/:accountNumber/events` | `201` event accepted and saved · `422` rejected by the ledger (nothing saved) · `400` bad body or account mismatch · `404` unknown account |

Other methods on these paths return `405`, and any other path returns `404`. Every error has the same JSON
shape: `{ "error": { "code": "...", "message": "..." } }`.

**The ledger response** (`GET`) has these fields:
- `account`: number, name, bank, BIC, IBAN, currency and `minorUnits`.
- `window`: `firstDay`, `lastDay`, `closedThroughDay`, `windowClosed`.
- `balances`: `opening`, `closing`, `activeHolds`, `available`, `interestAccrued`, `interestCapitalized`.
- `totals`: entry count, total debits, total credits, and `netMovement`.
- `entries`: every journal entry in processing order. Each entry has:
  - separate `debit` and `credit` columns (only one is set);
  - a running `balanceAfter`;
  - `postingDate`, `valueDate` and `processedOnDay`;
  - `refersTo`, `from`/`to` party blocks, and a `narration`.
- `valueDayBalances`: the closing balance of each day, as restated.
- `interestAccruals`, `authorizations`.
- `rejectedEvents`: this account's rejected events, with their error codes.

All money is a decimal string in major units (`"620.00"`, `"3.334"`), never a float.

**Adding an event** (`POST`):
- **Body.** One event in the [event format](#event-format-ndjson-one-per-line). The `account` comes from
  the path. If the body also has an `account`, it must match.
- **`day`.** If omitted, the event goes on the **last day already in the events file**. To start a new day,
  pass the next day (it must be inside the window).
- **`id`.** If omitted, one is generated (`API-<uuid>`).
- **Validation.** The event is first tried against a replay of the file with the event added.
  - If the ledger **rejects** it, the response is `422` with the ledger's own error code (for example
    `SETTLEMENT_UNKNOWN_AUTH` or `DUPLICATE_EVENT`). **Nothing is written.**
  - If it is **accepted**, the line is appended to the events file and flushed to disk (fsync). The
    response is `201` with:
    - `outcome`, `postingDay` and `processedOnDay`;
    - `narration`;
    - the stored `event`;
    - the ids of the journal `entries` it created;
    - the account's updated `ledger`.

### Persistence

The events NDJSON file is the only durable state. On start, the server replays it, so a restart rebuilds
exactly what was served before.
- The default file is `data/events.ndjson`. On first start it is created as a copy of the seed file
  (`data/scenario.ndjson` by default).
- `data/scenario.ndjson` itself is never written to, because the test suite checks its exact results.
- `data/events.ndjson` is local runtime state and is git-ignored. Delete it to start again from the scenario.

### How to run it

```bash
npm install          # once: installs Express and the TypeScript toolchain
npm run serve        # builds, replays data/events.ndjson, listens on http://127.0.0.1:3000
```

The server prints:

```
created data/events.ndjson from data/scenario.ndjson        (first start only)
replayed 10 events for 2 accounts; listening on http://127.0.0.1:3000
  try: curl http://127.0.0.1:3000/accounts/ACC-001/ledger
```

Options:

```bash
node dist/bin/serve.js [events.ndjson] [--accounts file] [--seed file] [--port N] [--host H] [--vat-bps N]
PORT=8080 HOST=0.0.0.0 npm run serve     # the port and host can also come from the environment
```

**1. Read a ledger**

```bash
curl http://127.0.0.1:3000/accounts/ACC-001/ledger
curl http://127.0.0.1:3000/accounts/ACC-002/ledger
```

For the scenario, ACC-001 closes at `"390.92"` and ACC-002 at `"10.008"`.

**2. Add an event.** No `day` is given, so it lands on the last day in the file (D6).

```bash
curl -X POST http://127.0.0.1:3000/accounts/ACC-001/events \
  -H 'content-type: application/json' \
  -d '{"id":"E11","type":"DEBIT","currency":"AED","amount":"50.00",
       "counterparty":{"accountNumber":"EXT-SHOP","accountName":"Shop"}}'
```

Response (abridged):

```json
{ "status": "ACCEPTED", "outcome": "POSTED", "postingDay": 6, "processedOnDay": 6,
  "entries": ["E11"], "ledger": { "balances": { "closing": "340.90", ... }, ... } }
```

The closing balance moves from 390.92 to 340.90. That is the 50.00 debit, plus 0.02 less D6 interest,
because interest is capitalized at the D6 close on the lower balance. The event is now the last line of
`data/events.ndjson`:

```json
{"id":"E11","day":6,"type":"DEBIT","currency":"AED","amount":"50.00","counterparty":{...},"account":"ACC-001"}
```

**3. A rejected event is not saved**

```bash
curl -i -X POST http://127.0.0.1:3000/accounts/ACC-001/events \
  -H 'content-type: application/json' \
  -d '{"id":"E12","type":"SETTLEMENT","currency":"AED","authId":"Auth-Q","amount":"5.00"}'
# HTTP/1.1 422  {"error":{"code":"SETTLEMENT_UNKNOWN_AUTH","message":"SETTLEMENT E12 on ACC-001 REJECTED ..."}, ...}
```

`data/events.ndjson` is unchanged.

**4. Check persistence.** Stop the server (Ctrl-C) and start it again:

```bash
npm run serve        # now prints: replayed 11 events for 2 accounts; ...
curl http://127.0.0.1:3000/accounts/ACC-001/ledger   # E11 is still there; closing is still "340.90"
```

**5. Start again from the scenario:** `rm data/events.ndjson`, then `npm run serve`.

### Tests

`test/api/ledger-endpoint.test.ts` covers the endpoints (8 tests, part of `npm test`). It runs a real
listener on an ephemeral port against a temp copy of the scenario file and checks:
- the ledger JSON for both accounts;
- that an accepted POST is appended to the file, shows up in `GET`, and survives a rebuild from the file (a
  restart);
- that rejected events (`DUPLICATE_EVENT`, `SETTLEMENT_UNKNOWN_AUTH`, `AMOUNT_PRECISION`, `OUT_OF_WINDOW`)
  return `422` and leave the file byte-for-byte unchanged;
- the `400`, `404` and `405` cases.

### Limits

- **The window is still D1–D6.** Interest is capitalized at the D6 close. An event on D6 is booked before
  that close, and a day past D6 is rejected with `OUT_OF_WINDOW`. An open-ended, rolling window would need
  a business rule for when interest capitalizes, and that is not decided here.
- **Every POST replays the whole events file.** That's instant at this size but grows with the file. A large
  stream would need snapshots.
- **Writes are serialized within one process.** Run a single server per events file.
- **The API runs the ledger in-process (one shard).** The worker-thread sharding is used only by the replay
  CLI.
