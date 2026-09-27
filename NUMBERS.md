# NUMBERS

This file lists every constant in the system, with where it comes from, why it has that value, and why
it is not half that value. "Given" means the brief fixes the value and I only chose its representation.
All constants live in `src/config.ts`, apart from currency precisions (`src/money.ts`) and constants
inside benchmark scripts.

---

## 1. Business constants

| Constant | Value | Source | Why this value, and not half it |
|---|---|---|---|
| Overdraft fee, AED | `'25.00'` → 2500 fils | Given | Given. Half (12.50) contradicts the brief. It is stored as a decimal string and parsed to integer fils, so no float ever holds it. |
| Overdraft fee, BHD | *(absent)* | Chosen | The brief prices the fee only in AED and gives no FX rate. The alternative to "absent" is inventing a conversion, and half of an invented number is still invented. See AMBIGUITIES A15. |
| Daily interest rate | `4 / 10 000` (0.04%) | Given | Given. Held as an integer rational `{num: 4, den: 10000}`, so accruals are exact integer arithmetic until the one rounding step. |
| AED precision | 2 dp | Given | Given (fils = 1/100). |
| BHD precision | 3 dp | Given | Given (fils = 1/1000). Half the precision would make E10's 10.000 unrepresentable as three instalments that sum exactly. |
| Capitalization day | 6 | Given | "At end of Day 6." |
| Window | D1–D6 | Given | Given. |
| VAT rate | 0 bps (option: 500) | Chosen | The user asked for VAT as a separate entry. The brief fixes the fee at AED 25.00, "non-negotiable". Any non-zero default changes every required balance, so 0 is the only default consistent with the brief. 500 bps (UAE standard 5%) is the value `--vat-bps` is tested with. Half of it (2.5%) matches no jurisdiction I'd want to assume. |
| Settlement over-hold tolerance | 0 bps | Chosen | The brief has no tolerance rule, and E5 settles *under* its hold. Any non-zero value is a policy that permits debiting more than was authorized. Half of 0 is 0. Real values (for example 15–20% for restaurants) belong to card-scheme configuration, not the core. |
| Max back-valuation | `null` (anywhere in the window) | Chosen | E7 is back-valued 3 days and E9 4 days, so the scenario needs at least 4. A limit of half the window (3 days) would **reject E9**. Unlimited within a 6-day window is the smallest safe choice. For long windows it should become a real limit (banks commonly allow 30–90 days). |
| Max instalments | 1000 | Chosen | Bounds the allocation loop and the per-event entry fan-out, so one event cannot create millions of entries. E10 needs 3. Half (500) would be just as safe. 1000 was picked as a round order of magnitude, and nothing depends on it beyond "much larger than any real instalment plan". |
| Max ID length | 64 chars | Chosen | Fits UUIDs (36) with room for prefixes. It caps per-event memory for hostile input. Half (32) would **reject a UUID with a prefix**. |
| Max counterparty field length | 140 chars | Chosen | SWIFT MT103 name/address lines are 4 × 35 = 140. Half (70) would truncate or reject legitimate remittance names. |

## 2. Rounding mode — round half to even

- **Where it applies:** interest accrual, VAT, and pro-rata VAT refunds. Instalment splits don't round;
  they use exact integer division plus largest remainder.
- **Why half-even and not half-up:** half-up biases upward on exact ties. Over many accounts and days that
  bias is systematic in the bank's disfavour on interest, and in the customer's on VAT. Half-even is
  unbiased on ties.
- **Effect on the scenario:** none. No exact ties occur (60.6 → 61, 76.2 → 76, 91.8 → 92), so half-up
  would give the same result here. Tests pin the tie cases (0.5 → 0, 1.5 → 2, 2.5 → 2).

## 3. Interest rounding scheme — carried remainder

Each day's accrual is `R(v) − R(v−1)`, where `R(v) = halfEven(Σ_{u≤v} max(0, closing_u) × 4 / 10000)` in
fils.

- The daily figures are integers and sum telescopically to `R(6)`, the correctly rounded total.
- The total error is at most ½ fils, whatever the number of days.

Rounding each day independently lets the error grow to ½ fils × days. In the scenario ACC-001 would
capitalize 0.93 against an exact 0.918.

| Scheme | ACC-001 daily fils (final) | Total |
|---|---|---|
| exact | 10, 9, 25, 16.6, 15.6, 15.6 | 91.8 |
| **carried (used)** | 10, 9, 25, 17, 15, 16 | **92** |
| independent | 10, 9, 25, 17, 16, 16 | 93 |

## 4. Numeric representation

| Item | Value | Why, and not half |
|---|---|---|
| Money type | JS Number holding integer minor units, guarded by `Number.isSafeInteger` | Measured against BigInt: 2× faster on the hot path. Safe up to 2^53−1 fils ≈ AED 90 trillion per account. Overflow raises `AMOUNT_OVERFLOW` before any state changes. |
| Per-account state | one `Float64Array` of 6 fields × 7 slots (D0–D6) | One object per account instead of five: 37 MB vs 281 MB at 200k accounts in `scripts/bench-numeric.ts`. |

## 5. Runtime and throughput constants

| Constant | Value | Why this value, and not half it |
|---|---|---|
| `batchSize` (events per worker message) | 2048 | Each `postMessage` has a fixed cost (serialise + wake). At about 180 bytes per line, 2048 events ≈ 370 KB per message, large enough to amortise that cost. Halving to 1024 doubles the message count for the same work. The upper bound is latency before a day-close barrier, and flushing at the barrier handles that. This was not micro-tuned: 2048 is a power of two in the range where message overhead stops dominating. |
| `maxInFlightBatches` per worker | 8 | Bounds router-side memory to about 8 × 370 KB × shards. Two batches is the minimum to keep a worker busy (one executing, one queued). 8 absorbs jitter from GC pauses in either thread. Half (4) would be fine on this box; 8 is the headroom choice. |
| Read chunk (`highWaterMark`) | 64 KiB | Node's default for file streams. Each chunk becomes one line batch, so one promise per about 350 lines. At half (32 KiB) the promise count doubles for no memory benefit worth having. |
| `detailAccountLimit` | 50 | Above this, the per-day report prints totals per currency rather than every account. With 50 accounts a day report is already about 3,000 lines. The scenario needs 2. Half (25) would also work. This is a readability limit, not a correctness one. |
| `errorSampleLimit` | 25 per day | Counts per code are always complete; this only caps the printed lines. 25 fills a screen. Half gives less diagnostic context with no gain. |
| Default `--shards` | 0 (in-process) | The scenario is 10 events, and worker startup (about 30 ms) costs more than the work. Sharding is opt-in for large streams. |
| `bench.js` default max shards | CPUs − 1 | Leaves one core for the router thread. |
| Generator seed | 42 (tests use 7) | Deterministic streams make benchmark runs comparable. The value is arbitrary. |
| Stack traces on `LedgerError` | disabled (limit 0) | Profiling showed stack capture at about 10% of CPU when about 10% of events are rejected. A rejection's stack has no information. `InvariantError` (bugs) keeps full stacks. |

## 6. Measured numbers (not constants — recorded so they aren't mistaken for claims)

Measured on this 2-vCPU container with Node 22, on a synthetic stream of 1M events and 100k accounts
(`npm run bench`, or see WORKLOG 17:43–17:49):

| Mode | Throughput | Peak RSS |
|---|---|---|
| In-process, journal retained (default) | about 68.6k events/s | about 1.98 GB |
| In-process, `--no-journal-retention` | about 77k events/s | about 1.66 GB |
| 2 shards, journal retained | about 85.9k events/s | about 2.20 GB |
| 2 shards, `--no-journal-retention` | about 93k events/s | about 1.91 GB |

On this box the router thread plus 2 workers oversubscribe 2 vCPUs, which explains the modest scaling.
