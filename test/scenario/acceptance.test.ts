/**
 * The brief's eight acceptance criteria, each checked against the replay.
 * ACCEPTED criteria are asserted as written. REJECTED criteria (see
 * REJECTED.md) are asserted to be FALSE, and the test pins what actually
 * happens instead, so the reasoning is executable.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runScenario, type Scenario } from '../helpers';

let S: Scenario;
test.before(async () => { S = await runScenario(); });

test('C1 ACCEPTED: Day 2 closing ledger balance, evaluated at end of Day 5 before any fee, is AED −370.00', () => {
  const d5 = S.acct(5, 'ACC-001');
  const r = d5.restated.find((x) => x.valueDate === 2);
  assert.ok(r, 'D2 must be restated at the D5 close');
  assert.equal(r.before, 25000, 'as known before E7: 250.00');
  assert.equal(r.preFee, -37000, 'pre-fee D2 balance at end of D5 is −370.00');
  // Independent recomputation from the journal: entries with value ≤ D2, excluding fees.
  // E9 (posted D6) is excluded because the question is asked at end of D5.
  const journal = S.shard.journal.filter((e) => e.account === 'ACC-001' && e.valueDate <= 2
    && e.processedOnDay <= 5 && e.kind !== 'FEE');
  const bal = journal.reduce((b, e) => b + (e.direction === 'CREDIT' ? e.amount : -e.amount), 0);
  assert.equal(bal, -37000);
});

test('C2 REJECTED: "E7 causes exactly one overdraft fee, on Day 2" — it causes three (D2, D4, D5)', () => {
  const fees = S.shard.journal.filter((e) => e.kind === 'FEE' && e.account === 'ACC-001');
  assert.notEqual(fees.length, 1);
  assert.deepEqual(fees.map((f) => f.valueDate), [2, 4, 5]);
  assert.ok(fees.every((f) => f.postingDate === 5 && f.amount === 2500), 'all assessed at the D5 close, AED 25.00 each');
  // No fee existed before E7 arrived: D1–D4 were all non-negative when first closed.
  for (const d of [1, 2, 3, 4]) assert.equal(S.acct(d, 'ACC-001').fees.length, 0);
  // D3 escapes: −395.00 (after D2 fee) + 400.00 = +5.00.
  assert.equal(S.acct(5, 'ACC-001').valueDayBalances[2], 500);
});

test('C3 ACCEPTED: the Day 4 settlement of Auth-A is accepted (185.00 against a 200.00 hold, 15.00 released)', () => {
  const log = S.shard.eventLog.find((l) => l.eventId === 'E5')!;
  assert.equal(log.status, 'ACCEPTED');
  const a = S.shard.auth('ACC-001', 'Auth-A')!;
  assert.equal(a.state, 'SETTLED');
  assert.equal(a.settledAmount, 18500);
  assert.equal(a.releasedAmount, 1500);
  assert.equal(S.acct(4, 'ACC-001').holds, 0);
  assert.equal(S.acct(4, 'ACC-001').closing, 46500);
});

test('C4 ACCEPTED: a settlement for an unknown auth id (Auth-Z) is rejected and no funds leave', () => {
  const log = S.shard.eventLog.find((l) => l.eventId === 'E6')!;
  assert.equal(log.status, 'REJECTED');
  assert.equal(log.code, 'SETTLEMENT_UNKNOWN_AUTH');
  assert.equal(S.shard.journal.filter((e) => e.eventId === 'E6').length, 0, 'no ledger entry for E6');
  assert.equal(S.acct(4, 'ACC-001').closing, 46500, '650.00 − 185.00 only');
  assert.deepEqual(S.byDay[4].errors.map((e) => e.eventId), ['E6']);
});

test('C5 ACCEPTED (conditional): an approved hold reduces available, not ledger — and Auth-B is in fact DECLINED', () => {
  // The rule, shown where it applies: Auth-A on D2.
  const d2 = S.acct(2, 'ACC-001');
  assert.equal(d2.closing, 25000, 'ledger unchanged by the hold');
  assert.equal(d2.available, 5000, 'available = 250.00 − 200.00');
  // Auth-B: E7 was booked before E8 on D5, so the ledger is −155.00 and available would be −245.00.
  const b = S.shard.auth('ACC-001', 'Auth-B')!;
  assert.equal(b.state, 'DECLINED');
  assert.equal(b.availableAfter, -24500);
  assert.equal(S.acct(5, 'ACC-001').holds, 0, 'a declined auth places no hold');
});

test('C6 REJECTED: "after E9 all balances and fees return to pre-E7 values" — fees stay, balance differs, Auth-B stays declined', () => {
  const preE7 = S.acct(4, 'ACC-001').closing; // last close before E7 arrived
  const d6 = S.acct(6, 'ACC-001');
  assert.equal(preE7, 46500);
  assert.equal(d6.preCapitalization, 39000, '465.00 − 3 × 25.00');
  assert.notEqual(d6.preCapitalization, preE7);
  assert.equal(S.shard.journal.filter((e) => e.kind === 'FEE').length, 3, 'fees are not un-assessed');
  assert.equal(d6.fees.length, 0, 'but no new fee after the reversal');
  assert.equal(S.shard.auth('ACC-001', 'Auth-B')?.state, 'DECLINED', 'a decision taken on D5 is not re-run');
  // E7 itself is still in the journal; the reversal is a separate entry.
  const e7 = S.shard.journal.find((e) => e.entryId === 'E7')!;
  const e9 = S.shard.journal.find((e) => e.entryId === 'E9')!;
  assert.equal(e7.direction, 'DEBIT');
  assert.equal(e9.direction, 'CREDIT');
  assert.equal(e9.refersTo, 'E7');
  assert.equal(e7.postingDate, 5, 'E7 keeps its first-arrival posting date');
});

test('C7 REJECTED: "three BHD instalments of 3.334 each" — that is 10.002; actual 3.334 + 3.333 + 3.333', () => {
  const inst = S.shard.journal.filter((e) => e.eventId === 'E10');
  assert.deepEqual(inst.map((e) => e.amount), [3334, 3333, 3333]);
  assert.equal(inst.reduce((a, e) => a + e.amount, 0), 10000);
  assert.ok(!inst.every((e) => e.amount === 3334));
  assert.deepEqual(inst.map((e) => e.instalment), ['1/3', '2/3', '3/3']);
});

test('C8 REJECTED: "remainder discarded" — there is no remainder; accrual records sum exactly to the capitalized credit', () => {
  for (const [id, expected] of [['ACC-001', 92], ['ACC-002', 8]]) {
    const recs = S.shard.accruals.filter((a) => a.account === id);
    const sum = recs.reduce((s, a) => s + a.amount, 0);
    const cap = S.shard.journal.find((e) => e.kind === 'INTEREST' && e.account === id)!;
    assert.equal(sum, expected);
    assert.equal(cap.amount, sum, `${id}: capitalized === Σ accrual records`);
  }
  // Per-value-day net accruals for ACC-001 as finally known: 0.10 0.09 0.25 0.17 0.15 0.16
  const net = [1, 2, 3, 4, 5, 6].map((v) => S.shard.accruals
    .filter((a) => a.account === 'ACC-001' && a.valueDate === v).reduce((s, a) => s + a.amount, 0));
  assert.deepEqual(net, [10, 9, 25, 17, 15, 16]);
});
