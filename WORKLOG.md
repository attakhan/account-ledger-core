# WORKLOG

Times are Asia/Dubai (UTC+04:00), taken from `date` at the moment of writing.
Each entry records what was done and what was decided. The entries are not tidied up afterwards.

---

### 2026-09-27 17:22 — brief received
Read the brief. It asks for an in-memory ledger core, a replay of 10 events over 6 days, and 8 acceptance
criteria, some of which are wrong. The user wants Node.js, error handling and "large volume".

### 2026-09-27 17:24 — user addendum
The user asked for a `postingDate` that stays equal to the first date the event came in. I decided that
every posting carries `postingDate` (never changes) and `valueDate`, and I added a separate `processedOnDay`
field for events that arrive after their day was closed (E10).

### 2026-09-27 17:30 — hand calculation before writing code
Worked the ACC-001 stream on paper first, so the code has something independent to be checked against.
- D1 250.00. D2 250.00 with Auth-A 200 approved (avail 50.00). D3 650.00. D4 465.00 (Auth-A settles 185,
  15 released). Auth-Z has no auth, so it is rejected.
- E7 is booked on D5 with value D2. At the D5 close, D2 = 250 − 620 = **−370.00** before the fee. So
  criterion 1 holds.
- After the re-run: D2 −395 (fee), D3 +5.00 (no fee), D4 −205 (fee), D5 −230 (fee). That makes **three**
  fees, not one, so criterion 2 is wrong.
- E8 Auth-B: at booking the balance is −155.00, so available after the hold is −245.00 and it is
  **declined**. Criterion 5 ("if approved") is only conditionally relevant.
- E9 reverses on D6. The balance is 390.00 before interest, against 465.00 before E7. The fees stay, so
  criterion 6 is wrong.
- 10.000 / 3 → 3.334 + 3.333 + 3.333. Three lots of 3.334 would be 10.002, so criterion 7 is wrong.
- "Remainder discarded" contradicts "must sum exactly", so criterion 8 is wrong.
- Open question: criterion 4 (reject an orphan settlement). Real card schemes force-post these. Leaning
  towards accepting the criterion, because the brief's own output asks for "errors" and the note on E6 is
  there to produce one.

### 2026-09-27 17:30 — repo scaffolded
`git init`, scenario NDJSON, accounts.json, package.json. No dependencies, only the Node standard library
(node:test, worker_threads, readline).

### 2026-09-27 17:31 — numeric representation decided by measurement
`scripts/bench-numeric.js` on this box (2 vCPU, Node 22):
- Hot add/compare loop, 20M ops: BigInt 183 ms, safe-integer Number 91 ms (with an `isSafeInteger` guard
  on every op).
- Per-day state for 200k accounts, 5 arrays × 7 days: BigInt arrays 296 MB, separate Float64Arrays 281 MB,
  **one packed Float64Array(35) per account 37 MB**.

Memory is dominated by per-object overhead, not by how the number is represented. Decision: integer minor
units held in JS Numbers, guarded by `Number.isSafeInteger` (overflow raises `AMOUNT_OVERFLOW` and nothing
is rounded silently), with one packed Float64Array per account. I first sketched BigInt everywhere and
abandoned that plan before writing the engine (see REJECTED.md).

### 2026-09-27 17:32–17:37 — user addenda folded into the design (mid-build)
- 17:32 Reversal, return and refund must each show **two separate entries** (the original and its opposite).
  The engine already wrote reversals as new entries. Now every entry has an explicit `direction` and a
  positive `amount` rather than a signed number, and I added `RETURN` and `REFUND` event types (partial
  allowed, capped at the original amount).
- 17:32 Charges and VAT go in separate entries. I added a `CHARGE` event, overdraft fees have kind `FEE`,
  and VAT is its own `VAT` entry linked by `refersTo`. The VAT rate defaults to **0 bps**, because the brief
  fixes the fee at AED 25.00 and says nothing about VAT (see AMBIGUITIES).
- 17:36 Every entry gets `from`/`to` party blocks. The own side comes from account master data and the other
  side from `counterparty` on the event. Fees, VAT and interest point at internal GL accounts. The user
  allowed dummy values, so accounts.json and the scenario now carry "ACC1 Account Name"-style placeholders.
- 17:37 Every entry and every event-log record gets a `narration` that describes the whole journey.
- Transfers between two ledger accounts are two legs sharing a `transferId`, not one atomic event. See
  REJECTED.md for why I dropped the atomic cross-shard TRANSFER.

### 2026-09-27 17:40 — engine first run matches the hand calculation
The first end-to-end replay (in-process) gave exactly the numbers worked out at 17:30:
- D5 close: fees at value D2, D4, D5. D2 pre-fee −370.00 (criterion 1 holds). Auth-B DECLINED at −245.00.
- D6 close: ACC-001 390.00 + 0.92 interest = **390.92**. ACC-002 10.000 + 0.008 = **10.008**.
- ACC-001 accrual records: D1 +10, D2 +10, D3 +26, D4 +19, then −10/−26/−19 at the D5 close, then
  +9/+25/+17/+15/+16 at the D6 close. That is 12 records summing to 92 = the capitalized 0.92.
- E10 instalments are 3.334 / 3.333 / 3.333, with LATE_ARRIVAL, postingDate D5 and processedOnDay D6.

### 2026-09-27 17:42 — sharded replayer and CLI
- Added `ShardedEngine`: worker_threads, FNV-1a routing by account, batches of 2048, at most 8 batches in flight
  per worker (backpressure), and day close as a barrier.
- Scenario output is byte-identical for in-process, `--shards 2` and `--shards 3`.
- The 50k synthetic stream differed between modes **only in the order of error-code keys** (insertion order
  depends on the shard). The merge now sorts the keys, and the output is identical after that.

### 2026-09-27 17:43–17:49 — performance: the first numbers were bad, and here is what fixed them
The 1M events / 100k accounts synthetic stream on this 2-vCPU box first ran at **60,518 ev/s with 2.44 GB peak RSS**.
The CPU profile of a 300k slice showed GC at about 40%. `LedgerError` construction was about 10%, because each
one captured a stack.
1. LedgerError no longer captures a stack (`Error.stackTraceLimit = 0` around `super`). A rejection has no
   use for a stack.
2. The replayer read with a readline `for await`, which cost one promise per line. It now reads line
   *batches* per 64 KiB chunk and calls `engine.apply` synchronously (a promise only under backpressure).
3. Heap probe: accounts took 102 MB for 100k, so the `seen`/`refs`/`auths` maps are now allocated lazily and
   merged into a single `ids` map. Down to 46 MB.
4. Spread-copied ref objects became a fixed-shape `Ref` class.
5. **Narration strings.** The template-literal concatenation leaves V8 rope strings. A micro-test showed 200k
   ropes at 354 MB against 55 MB flat. `(' ' + s).slice(1)` flattens a string (measured 61 MB, and faster).
   Tried `charCodeAt` and `indexOf`, and neither flattened. Accepted narrations are also no longer copied a
   second time into the event log.
6. Sharded mode now ships the original line string to workers rather than the parsed object, so a
   structured clone of a string replaces a clone of the object graph.

After these changes, 1M events: in-process 77k ev/s / 1.66 GB (journal not retained) and 68.6k ev/s /
1.98 GB (journal retained, the default). With `--shards 2`: 93k / 1.91 GB and 85.9k / 2.20 GB. The box has
2 vCPUs, so main thread + 2 workers oversubscribe it, and the sharding gain here is modest. I did **not**
measure more cores and don't claim a number for them.

Memory is the real ceiling. Each event keeps an event-log record with a narration, a journal entry with
from/to blocks and a narration, and a Ref. That is about 1.9 KB per event all-in at 1M. That cost follows
from "in-memory, append-only, nothing deleted" plus the narration requirement. It is written up in
AMBIGUITIES/README rather than hidden.

### 2026-09-27 17:52 — test suite; the determinism test caught a real bug
- `npm test` has 48 tests: money, validation, shard rules, the 8 acceptance criteria (accepted ones asserted
  as written, rejected ones asserted false with the actual values pinned), the per-day output for D1–D6,
  sharded ≡ in-process, and the CLI.
- **Bug found by the sharding test:** accrual IDs used a shard-global counter (`this.accruals.length`), so
  the same scenario produced `ACR:ACC-002:D5:12` in-process and `ACR:ACC-002:D5:0` with 2 shards. Changed
  to a per-account counter. The text output never showed accrual IDs, so the earlier diff of CLI output
  could not have caught it. Only a full JSON comparison could.
- The first draft of one of my own unit assertions was wrong: I expected (2^52+1)/2 → 2^51+1, but half-even
  keeps 2^51. The test was fixed, not the code.
- Known-failing test: `test/known-failing/fees-after-reversal.test.js`. It shows AED 75.00 in fees surviving
  a same-value-date reversal, and a control test shows the fees depend on arrival order.
