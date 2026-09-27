'use strict';
/**
 * KNOWN-FAILING TEST. It is written against my own design and it fails on purpose.
 * Run with `npm run test:known-failing`. `npm test` excludes it so CI stays meaningful.
 *
 * The claim it makes: a customer should not end the window paying overdraft
 * fees that exist only because of a posting the bank itself fully reversed
 * with the same value date.
 *
 * Why it fails: the design assesses fees on the balance as known at each day
 * close, never un-assesses them, and has no rule that auto-refunds them. So E7
 * (posted D5, value D2) creates fees for D2, D4 and D5. E9 (posted D6, value
 * D2) removes the negative balance that caused them, yet all three stay:
 * AED 75.00 charged for an overdraft that, as finally restated, never existed.
 *
 * What it reveals:
 *  1. The ledger is correct and the product is not. "Assessed once per day
 *     when closing balance is negative" is honoured to the letter, but the
 *     closing balance that triggered each fee has since been restated to
 *     positive (D2 225.00, D4 415.00, D5 390.00). A fee is a fact about a
 *     balance the bank now says was wrong.
 *  2. The fix is policy, not arithmetic. With append-only records it would be
 *     a REFUND entry per fee (the REFUND event type and fee refunds already
 *     exist; see test/unit/shard.test.js). What the brief does not say is
 *     *when* to fire it: only for reversals? for any restatement that turns
 *     the day positive? what if the reversal is partial? That rule must not
 *     be invented inside the core (see AMBIGUITIES.md A7).
 *  3. Order-dependence. Had E9 arrived on D5 before the D5 close, no fee
 *     would ever have been assessed. The same final ledger then carries AED
 *     75.00 less in fees. The customer's charges depend on when a correction
 *     arrives, not only on what it corrects.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { runScenario, scenarioLines } = require('../helpers');

test('KNOWN-FAILING: fees caused solely by a fully reversed posting are refunded by end of window', async () => {
  const S = await runScenario();

  const feeDebits = S.shard.journal
    .filter((e) => e.account === 'ACC-001' && e.kind === 'FEE')
    .reduce((s, e) => s + e.amount, 0);
  const feeRefunds = S.shard.journal
    .filter((e) => e.account === 'ACC-001' && e.kind === 'REFUND' && String(e.refersTo).startsWith('FEE:'))
    .reduce((s, e) => s + e.amount, 0);

  // Every day that had a fee is non-negative in the final restated view…
  for (const f of S.shard.journal.filter((e) => e.kind === 'FEE')) {
    const finalPreFee = S.shard.closingBalance('ACC-001', f.valueDate) + 2500 * countFeesUpTo(S, f.valueDate);
    assert.ok(finalPreFee >= 0, `D${f.valueDate} is no longer negative once E9 is applied`);
  }
  // …so the net fee charge should be zero. ACTUAL: 7500 (AED 75.00), 0 refunded.
  assert.equal(feeDebits - feeRefunds, 0,
    `customer still pays ${(feeDebits - feeRefunds) / 100} AED in fees for an overdraft that was reversed out of existence`);
});

test('(control, passes) the same corrections in a different arrival order yield different fees', async () => {
  // E9 moved before the D5 close: the stream order is the only difference.
  const lines = scenarioLines().map((l) => (l.includes('"id":"E9"') ? l.replace('"day":6', '"day":5') : l));
  const i9 = lines.findIndex((l) => l.includes('"id":"E9"'));
  const [e9] = lines.splice(i9, 1);
  lines.splice(lines.findIndex((l) => l.includes('"id":"E8"')) + 1, 0, e9);
  const early = await runScenario({ lines });
  const fees = early.shard.journal.filter((e) => e.kind === 'FEE').length;
  assert.equal(fees, 0, 'no fees when the reversal lands before the close. Order-dependence made visible');
});

function countFeesUpTo(S, v) {
  return S.shard.journal.filter((e) => e.kind === 'FEE' && e.valueDate <= v).length;
}
