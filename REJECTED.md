# REJECTED

This file has two parts:
- **Part 1** lists the acceptance criteria I refused, with the reasoning.
- **Part 2** lists the approaches I abandoned during the build.

Every verdict in Part 1 is also an executable test in `test/scenario/acceptance.test.ts`. Accepted
criteria are asserted as written. Rejected criteria are asserted to be false, and the test pins the
value that actually happens.

Amounts below are in the account's currency. The code works in minor units.

---

## Part 1 — Acceptance criteria

| #  | Criterion (abridged)                                           | Verdict                            |
|----|----------------------------------------------------------------|------------------------------------|
| C1 | D2 closing, evaluated end of D5 before any fee, is −370.00     | **Accepted**                       |
| C2 | E7 causes exactly one overdraft fee, on D2                     | **Rejected**                       |
| C3 | Day 4 settlement of Auth-A must be accepted                    | **Accepted**                       |
| C4 | Settlement with unknown auth ID rejected, funds don't leave    | **Accepted** (with a caveat)       |
| C5 | If Auth-B is approved, hold reduces available but not ledger   | **Accepted** (premise false here)  |
| C6 | After E9, all balances and fees return to pre-E7 values        | **Rejected**                       |
| C7 | The three BHD instalments of E10 must each be 3.334            | **Rejected**                       |
| C8 | If rounded accruals ≠ capitalized total, remainder discarded   | **Rejected**                       |

### C2 — REJECTED: "E7 causes exactly one overdraft fee to be assessed, on Day 2"

E7 is booked on D5 with value date D2. The fee rule says the balance for a day includes "all entries with
value_date ≤ that day", and the fee is "booked with value_date equal to the day assessed". So once E7 is
known, the D5 close has to look at every earlier day again, not just D2.

Value-day balances at the D5 close, taking each fee into account as it is assessed:

| Value day | Before fee | Fee? | After fee |
|---|---|---|---|
| D1 | 250.00 | no | 250.00 |
| D2 | 250.00 − 620.00 = **−370.00** | yes | −395.00 |
| D3 | −395.00 + 400.00 = **+5.00** | no | 5.00 |
| D4 | 5.00 − 185.00 = **−180.00** | yes | −205.00 |
| D5 | **−205.00** | yes | −230.00 |

E7 therefore causes **three** fees (D2, D4 and D5), all posted D5.

The alternative reading does not rescue the criterion either. If fees were assessed only on the processing
day's own balance, and never back-dated, E7 would cause one fee on **D5**, not on D2. Under neither reading
is it "exactly one, on Day 2".

The D3 case is worth noting. D3 escapes the fee only by 5.00. Had the D2 fee been left out of D3's balance,
D3 would be +30.00, so the result is the same either way.

### C6 — REJECTED: "After E9, all balances and fees return to their pre-E7 values"

Three separate facts make this false:
1. **The fees stay.** The ledger is append-only, and the brief's fee rule has no un-assessment clause. The
   three AED 25.00 fees posted at the D5 close remain.
   - End of D4 (last close before E7): **465.00**.
   - End of D6 after E9, before interest: **390.00** (465.00 − 3 × 25.00). With interest capitalized: 390.92.
2. **The Auth-B decision is path-dependent.** It was declined on D5, when available would have been −245.00.
   A reversal on D6 does not re-run that decision.
3. **E7 is not undone.** It stays in the journal as a DEBIT, and E9 is a *separate* CREDIT entry with
   `refersTo: E7` (as the user also asked). The records do not "return" to anything. Only the net effect of
   the principal is neutralised.

One could argue the fees *should* be refunded. The known-failing test argues exactly that. But refunding is a
policy the brief does not state, and the criterion claims more than refunds would give (point 2 above).
See AMBIGUITIES A7.

### C7 — REJECTED: "The three BHD instalments in E10 must each be BHD 3.334"

3 × 3.334 = **10.002**, which would create 0.002 BHD from nothing. The instalments must sum to the
instructed 10.000. At 3 decimal places, three equal instalments of 10.000 do not exist.

Resolution: largest-remainder allocation, giving **3.334 + 3.333 + 3.333 = 10.000**. The single
indivisible fils goes to the first instalment.

### C8 — REJECTED: "If the rounded daily interest accruals do not sum to the capitalized total, the remainder is discarded"

This contradicts the non-negotiable rule: "The rounded daily accruals must sum exactly to the capitalized
total." The design makes the two sums equal by construction: the capitalized credit **is** Σ(accrual
records). An invariant check (`InvariantError`) runs at every close. So there is never a remainder to
discard.

Where the idea of a "remainder" really comes from is the gap between exact and rounded daily accruals. That
is handled by carrying it forward, not discarding it (NUMBERS.md §3):

| | Amount |
|---|---|
| ACC-001 exact total | 91.8 fils |
| Capitalized | 92 fils = 0.92 |
| Rounding each day separately (a lossy scheme) | 93 fils |

Discarding a remainder would also mean discarding customer money silently, which no rule allows.

### C1 — ACCEPTED

At the end of D5 the entries with value date ≤ D2 are E1 (+1,200.00), E2 (−950.00) and E7 (−620.00). E9 is
posted D6, so it is not yet known. That gives **−370.00**.

This is also the balance on which the D2 fee is decided, so "before any fee" is exactly the pre-fee figure
the engine records (`preFee` in the D5 restatement).

### C3 — ACCEPTED

- Auth-A was approved on D2 (available 250.00 − 200.00 = 50.00 ≥ 0).
- On D4, 185.00 ≤ the 200.00 hold, so it settles.
- The 15.00 difference is released and the hold is removed.
- A settlement against an approved hold does not re-check available balance: the hold already reserved the
  funds.
- E7, which later makes D2 negative, was unknown on D2. Authorization decisions are point-in-time.

### C4 — ACCEPTED, with a caveat

E6 (Auth-Z) is rejected with `SETTLEMENT_UNKNOWN_AUTH`. It creates no journal entry and the D4 balance is
465.00.

Caveat: in real card schemes, settlements without a matching auth (offline or forced posts, expired auths)
are a liability the issuer usually has to post and then dispute. The brief's rule is the conservative one
for a ledger with no chargeback flow, and the brief asks for errors in the output, which this produces. See
AMBIGUITIES A8.

### C5 — ACCEPTED as a rule; the premise does not hold in this stream

The rule holds and is exercised by Auth-A on D2: ledger 250.00, available 50.00.

Auth-B, however, is **declined**. E7 is booked on D5 *before* E8 in stream order, so the ledger is −155.00
and available after the hold would be −245.00. The criterion is conditional ("If…"), so it is true, but in
this scenario it only ever applies to Auth-A.

---

## Part 2 — Approaches abandoned mid-build

1. **BigInt for all money.** This was the first plan.
   - Measured before writing the engine (`scripts/bench-numeric.ts`): BigInt was about 2× slower in the hot
     loop. Its memory was about the same as separate typed arrays, but 8× worse than one packed
     Float64Array per account.
   - Replaced by safe-integer Numbers, with an `isSafeInteger` guard on every operation and
     `AMOUNT_OVERFLOW` instead of silent loss.

2. **Rounding each day's accrual independently.** Rejected once the numbers were worked out. It drifts:
   ACC-001 gives 93 fils against an exact 91.8. Replaced by rounding the cumulative total and carrying the
   remainder (half-even), so Σ rounded = round(Σ exact), with the error bounded by half a fils in total.

3. **Overwriting past days' accruals when a back-valued entry arrives.** That is a mutation, which is
   forbidden. Replaced by `ACCRUAL_ADJUSTMENT` records posted at the close that learns of the change.

4. **Sorting the stream by booked day so E10 lands in D5.** The brief says "replayed in this order". E10
   is instead a late arrival: its posting date D5 is kept, it is processed on D6, and D5 is restated at the
   D6 close.

5. **An atomic cross-account `TRANSFER` event.** Considered after the user asked for from/to account
   information.
   - With accounts sharded across worker threads, one event touching two shards needs a two-phase commit
     between threads. It would also make the sharded and in-process modes able to disagree on partial
     failure.
   - Replaced by two legs that share a `transferId`, each carrying the other account as counterparty.
   - What this gives up: the two legs are not atomic, so a rejected leg must be reconciled by the caller.
     It is documented in the README.

6. **Parsing each line with a readline `for await` loop and awaiting `engine.apply` per event.** It worked
   but cost one promise per line. Replaced by chunked line batches and a synchronous `apply` that only
   returns a promise under backpressure.

7. **Shipping parsed objects to worker threads.** The structured clone of the object graph made 2 shards
   *slower* than in-process (52k vs 62k events/s on the 50k stream). Replaced by shipping the original
   line string, which the worker re-parses.

8. **A global accrual counter for accrual IDs.** It made IDs depend on the shard count. The sharding
   determinism test caught it. Replaced by a per-account counter.

9. **Template-literal narrations stored as built.** V8 keeps them as rope strings, about 6× the memory of
   flat text. They are now flattened on creation. See WORKLOG 17:43–17:49.

10. **Idempotency across the whole stream (global event-ID set).** Rejected in favour of per-account
    scope. A global set would need a single owner in the router: extra memory there and a serial point.
    It would also make sharded and in-process results differ unless both used it. Consequence: the same
    event ID on two *different* accounts is accepted twice. See AMBIGUITIES A18.
