'use strict';
/**
 * Pins the full per-day output of the brief's replay: closing ledger balance,
 * fee assessments, authorization states and errors, for every day and account.
 * Numbers are minor units (fils).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { runScenario } = require('../helpers');

let S;
test.before(async () => { S = await runScenario(); });

const EXPECTED = {
  // day: [ACC-001 closing, available, feeValueDates, auth states, ACC-002 closing, error event ids]
  1: [25000, 25000, [], {}, 0, []],
  2: [25000, 5000, [], { 'Auth-A': 'APPROVED' }, 0, []],
  3: [65000, 45000, [], { 'Auth-A': 'APPROVED' }, 0, []],
  4: [46500, 46500, [], { 'Auth-A': 'SETTLED' }, 0, ['E6']],
  5: [-23000, -23000, [2, 4, 5], { 'Auth-A': 'SETTLED', 'Auth-B': 'DECLINED' }, 0, []],
  6: [39092, 39092, [], { 'Auth-A': 'SETTLED', 'Auth-B': 'DECLINED' }, 10008, []],
};

for (const [day, [c1, av1, fees, auths, c2, errs]] of Object.entries(EXPECTED)) {
  test(`Day ${day} close`, () => {
    const a1 = S.acct(Number(day), 'ACC-001');
    const a2 = S.acct(Number(day), 'ACC-002');
    assert.equal(a1.closing, c1, 'ACC-001 closing ledger');
    assert.equal(a1.available, av1, 'ACC-001 available');
    assert.deepEqual(a1.fees.map((f) => f.valueDate), fees, 'ACC-001 fees assessed at this close');
    assert.deepEqual(Object.fromEntries(a1.auths.map((x) => [x.authId, x.state])), auths);
    assert.equal(a2.closing, c2, 'ACC-002 closing ledger');
    assert.equal(a2.fees.length, 0);
    assert.deepEqual(S.byDay[day].errors.map((e) => e.eventId), errs);
  });
}

test('end-of-window restated value-day balances', () => {
  assert.deepEqual(S.acct(6, 'ACC-001').valueDayBalances, [25000, 22500, 62500, 41500, 39000, 39092]);
  assert.deepEqual(S.acct(6, 'ACC-002').valueDayBalances, [0, 0, 0, 0, 10000, 10008]);
});

test('E10 arrives late: postingDate D5 kept, processed D6, LATE_ARRIVAL notice, D5 restated', () => {
  const inst = S.shard.journal.filter((e) => e.eventId === 'E10');
  assert.ok(inst.every((e) => e.postingDate === 5 && e.valueDate === 5 && e.processedOnDay === 6));
  assert.deepEqual(S.byDay[6].notices.filter((n) => n.eventId === 'E10').map((n) => n.code), ['LATE_ARRIVAL']);
  assert.deepEqual(S.acct(6, 'ACC-002').restated, [{ valueDate: 5, before: 0, preFee: 10000, after: 10000, feeAssessedNow: false }]);
});

test('fees carry postingDate = assessment close, valueDate = day assessed', () => {
  const fees = S.shard.journal.filter((e) => e.kind === 'FEE');
  assert.deepEqual(fees.map((f) => [f.valueDate, f.postingDate]), [[2, 5], [4, 5], [5, 5]]);
});

test('ledger invariant: closing balance of every value day equals Σ journal entries with value ≤ that day', () => {
  for (const id of ['ACC-001', 'ACC-002']) {
    for (let v = 1; v <= 6; v++) {
      assert.equal(S.shard.balanceFromJournal(id, v), S.shard.closingBalance(id, v), `${id} D${v}`);
    }
  }
});

test('every journal entry has from/to blocks, a direction, a positive amount and a narration', () => {
  for (const e of S.shard.journal) {
    assert.ok(e.direction === 'DEBIT' || e.direction === 'CREDIT');
    assert.ok(Number.isSafeInteger(e.amount) && e.amount > 0);
    assert.ok(typeof e.narration === 'string' && e.narration.includes(`posted D${e.postingDate}, value D${e.valueDate}`));
    const own = e.direction === 'CREDIT' ? e.to : e.from;
    assert.equal(own.accountNumber, e.account, 'own side is on the side the direction implies');
  }
  const fee = S.shard.journal.find((e) => e.entryId === 'FEE:ACC-001:D2');
  assert.equal(fee.to.accountNumber, 'GL-4100');
  assert.match(fee.narration, /D2 closing balance AED -370\.00 recomputed at D5 close after back-valued E7/);
  const e9 = S.shard.journal.find((e) => e.entryId === 'E9');
  assert.equal(e9.from.accountNumber, 'EXT-E7-PAYEE', 'a reversal flips the parties of the original');
  assert.equal(e9.to.accountName, 'ACC1 Account Name');
});

test('append-only: records are frozen; the log keeps every inbound event including rejected ones', () => {
  'use strict';
  const e = S.shard.journal[0];
  assert.throws(() => { e.amount = 1; }, TypeError);
  assert.throws(() => { S.shard.eventLog[0].status = 'X'; }, TypeError);
  assert.throws(() => { S.shard.accruals[0].amount = 1; }, TypeError);
  assert.deepEqual(S.shard.eventLog.map((l) => [l.eventId, l.status]), [
    ['E1', 'ACCEPTED'], ['E2', 'ACCEPTED'], ['E3', 'ACCEPTED'], ['E4', 'ACCEPTED'], ['E5', 'ACCEPTED'],
    ['E6', 'REJECTED'], ['E7', 'ACCEPTED'], ['E8', 'ACCEPTED'], ['E9', 'ACCEPTED'], ['E10', 'ACCEPTED']]);
});

test('accrual history is append-only: D5 close claws back D2–D4, D6 close re-accrues', () => {
  const acc = S.shard.accruals.filter((a) => a.account === 'ACC-001').map((a) => [a.valueDate, a.postingDate, a.amount, a.kind]);
  assert.deepEqual(acc, [
    [1, 1, 10, 'ACCRUAL'], [2, 2, 10, 'ACCRUAL'], [3, 3, 26, 'ACCRUAL'], [4, 4, 19, 'ACCRUAL'],
    [2, 5, -10, 'ACCRUAL_ADJUSTMENT'], [3, 5, -26, 'ACCRUAL_ADJUSTMENT'], [4, 5, -19, 'ACCRUAL_ADJUSTMENT'],
    [2, 6, 9, 'ACCRUAL_ADJUSTMENT'], [3, 6, 25, 'ACCRUAL_ADJUSTMENT'], [4, 6, 17, 'ACCRUAL_ADJUSTMENT'],
    [5, 6, 15, 'ACCRUAL_ADJUSTMENT'], [6, 6, 16, 'ACCRUAL'],
  ]);
});
