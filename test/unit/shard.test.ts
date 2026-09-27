import test from 'node:test';
import assert from 'node:assert/strict';
import { harness } from '../helpers';
import { DEFAULT_POLICY } from '../../src/config';
import type { Policy } from '../../src/types';

const A = 'ACC-001';
const B = 'ACC-002';
type Extra = Record<string, unknown>;
const cr = (id: string, day: number, amount: unknown, extra: Extra = {}) => ({ id, day, type: 'CREDIT', account: A, currency: 'AED', amount, valueDate: day, ...extra });
const dr = (id: string, day: number, amount: unknown, extra: Extra = {}) => ({ id, day, type: 'DEBIT', account: A, currency: 'AED', amount, valueDate: day, ...extra });
const withVat: Policy = Object.freeze({ ...DEFAULT_POLICY, vatBps: Object.freeze({ AED: 500, BHD: 0 }) });

test('authorization boundary: approved when available lands exactly on zero, declined one fil over', () => {
  const h = harness();
  h.ev(cr('c', 1, '100.00'));
  assert.equal(h.ev({ id: 'a1', day: 1, type: 'AUTHORIZATION', account: A, currency: 'AED', authId: 'X', amount: '100.00' }).outcome, 'AUTH_APPROVED');
  assert.equal(h.shard.available(A), 0);
  assert.equal(h.ev({ id: 'a2', day: 1, type: 'AUTHORIZATION', account: A, currency: 'AED', authId: 'Y', amount: '0.01' }).outcome, 'AUTH_DECLINED');
  assert.equal(h.shard.bookBalance(A), 10000, 'holds never touch the ledger');
});

test('settlement rules: declined auth, double settle, over-hold, duplicate auth id', () => {
  const h = harness();
  h.ev(cr('c', 1, '50.00'));
  h.ev({ id: 'a1', day: 1, type: 'AUTHORIZATION', account: A, currency: 'AED', authId: 'OK', amount: '40.00' });
  h.ev({ id: 'a2', day: 1, type: 'AUTHORIZATION', account: A, currency: 'AED', authId: 'NO', amount: '40.00' });
  const st = (id: string, auth: string, amount: string) => h.ev({ id, day: 1, type: 'SETTLEMENT', account: A, currency: 'AED', authId: auth, amount });
  assert.equal(st('s1', 'NO', '10.00').code, 'SETTLEMENT_AUTH_DECLINED');
  assert.equal(st('s2', 'OK', '40.01').code, 'SETTLEMENT_EXCEEDS_AUTH');
  assert.equal(st('s3', 'OK', '40.00').status, 'ACCEPTED');
  assert.equal(st('s4', 'OK', '1.00').code, 'SETTLEMENT_AUTH_ALREADY_SETTLED');
  assert.equal(h.ev({ id: 'a3', day: 1, type: 'AUTHORIZATION', account: A, currency: 'AED', authId: 'OK', amount: '1.00' }).code, 'DUPLICATE_AUTH_ID');
  assert.equal(h.shard.bookBalance(A), 1000);
});

test('duplicate event id is rejected and the first postingDate stands', () => {
  const h = harness();
  h.ev(cr('E1', 1, '10.00'));
  h.close(1);
  const r = h.ev(cr('E1', 2, '99.00'));
  assert.equal(r.code, 'DUPLICATE_EVENT');
  const entries = h.shard.journal.filter((e) => e.eventId === 'E1');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].postingDate, 1);
  assert.equal(entries[0].amount, 1000);
});

test('value-date guards: future, before window, before the original', () => {
  const h = harness();
  assert.equal(h.ev(cr('f', 1, '1.00', { valueDate: 2 })).code, 'VALUE_DATE_IN_FUTURE');
  assert.equal(h.ev(cr('o', 1, '1.00', { valueDate: 0 })).code, 'VALUE_DATE_TOO_OLD');
  h.ev(dr('d', 1, '5.00'));
  h.closeThrough(2);
  h.ev(dr('d3', 3, '5.00'));
  assert.equal(h.ev({ id: 'r', day: 3, type: 'REVERSAL', account: A, reverses: 'd3', valueDate: 2 }).code, 'VALUE_DATE_BEFORE_ORIGINAL');
});

test('structural validation errors do not throw and do not move money', () => {
  const h = harness();
  const bad: [unknown, string][] = [
    [null, 'INVALID_EVENT'],
    [{ id: 'x', day: 1, type: 'TELEPORT', account: A }, 'UNKNOWN_EVENT_TYPE'],
    [cr('x2', 1, 12.5), 'INVALID_AMOUNT'],
    [cr('x3', 1, '1.001'), 'AMOUNT_PRECISION'],
    [cr('x4', 1, '0.00'), 'INVALID_AMOUNT'],
    [{ ...cr('x5', 1, '1.00'), currency: 'BHD' }, 'CURRENCY_MISMATCH'],
    [{ ...cr('x6', 1, '1.00'), account: 'NOPE' }, 'UNKNOWN_ACCOUNT'],
    [{ ...cr('x7', 1, '1.00'), day: 9 }, 'OUT_OF_WINDOW'],
    [{ ...cr('x8', 1, '1.00'), counterparty: { accountNumber: 'Z', swift: 'nope' } }, 'INVALID_EVENT'],
    [{ id: 'x9', day: 1, type: 'SETTLEMENT', account: A, currency: 'AED', amount: '1.00' }, 'INVALID_EVENT'],
  ];
  for (const [e, code] of bad) assert.equal(h.ev(e).code, code, JSON.stringify(e));
  assert.equal(h.shard.bookBalance(A), 0);
  assert.equal(h.shard.journal.length, 0);
  assert.equal(h.shard.eventLog.filter((l) => l.status === 'REJECTED').length, bad.length);
});

test('reversal, return and refund each add a SEPARATE opposite entry; the original is untouched', () => {
  const h = harness();
  h.ev(cr('c', 1, '1000.00'));
  h.ev(dr('d', 1, '300.00', { counterparty: { accountNumber: 'SHOP', accountName: 'Shop Name', bankName: 'Shop Bank' } }));
  assert.equal(h.ev({ id: 'ret1', day: 1, type: 'RETURN', account: A, currency: 'AED', refersTo: 'd', amount: '100.00' }).outcome, 'RETURN_PARTIAL');
  assert.equal(h.ev({ id: 'ret2', day: 1, type: 'RETURN', account: A, currency: 'AED', refersTo: 'd', amount: '250.00' }).code, 'REFUND_EXCEEDS_REMAINING');
  assert.equal(h.ev({ id: 'rv', day: 1, type: 'REVERSAL', account: A, reverses: 'd' }).code, 'REVERSAL_AFTER_PARTIAL_REFUND');
  assert.equal(h.ev({ id: 'rf', day: 1, type: 'REFUND', account: A, refersTo: 'd' }).outcome, 'REFUND_FULL');
  assert.equal(h.ev({ id: 'rf2', day: 1, type: 'REFUND', account: A, refersTo: 'd', amount: '0.01', currency: 'AED' }).code, 'REFUND_EXCEEDS_REMAINING');
  const rows = h.shard.journal.map((e) => [e.entryId, e.kind, e.direction, e.amount, e.refersTo]);
  assert.deepEqual(rows, [
    ['c', 'CREDIT', 'CREDIT', 100000, null],
    ['d', 'DEBIT', 'DEBIT', 30000, null],
    ['ret1', 'RETURN', 'CREDIT', 10000, 'd'],
    ['rf', 'REFUND', 'CREDIT', 20000, 'd'],
  ]);
  const ret = h.shard.journal[2];
  assert.equal(ret.from?.accountNumber, 'SHOP');
  assert.equal(ret.to?.accountNumber, A);
  assert.equal(h.shard.bookBalance(A), 100000);
  // a credit can be reversed (DEBIT entry) but not refunded
  assert.equal(h.ev({ id: 'rfc', day: 1, type: 'REFUND', account: A, refersTo: 'c' }).code, 'REFERENCE_NOT_ELIGIBLE');
  assert.equal(h.ev({ id: 'rvc', day: 1, type: 'REVERSAL', account: A, reverses: 'c' }).outcome, 'REVERSED');
  assert.equal(h.ev({ id: 'rvc2', day: 1, type: 'REVERSAL', account: A, reverses: 'c' }).code, 'ALREADY_REVERSED');
  assert.equal(h.ev({ id: 'rvx', day: 1, type: 'REVERSAL', account: A, reverses: 'nope' }).code, 'REFERENCE_NOT_FOUND');
});

test('reversing an instalment credit mirrors each instalment as its own entry', () => {
  const h = harness();
  h.ev({ id: 'i', day: 1, type: 'CREDIT', account: B, currency: 'BHD', amount: '10.000', instalments: 3 });
  h.ev({ id: 'r', day: 1, type: 'REVERSAL', account: B, reverses: 'i' });
  const rev = h.shard.journal.filter((e) => e.eventId === 'r');
  assert.deepEqual(rev.map((e) => [e.entryId, e.direction, e.amount, e.refersTo]),
    [['r#1', 'DEBIT', 3334, 'i#1'], ['r#2', 'DEBIT', 3333, 'i#2'], ['r#3', 'DEBIT', 3333, 'i#3']]);
  assert.equal(h.shard.bookBalance(B), 0);
});

test('VAT (when enabled) is a separate entry on fees and charges, and is refunded separately', () => {
  const h = harness({ policy: withVat });
  h.ev(dr('d', 1, '10.00'));
  h.ev({ id: 'ch', day: 1, type: 'CHARGE', account: A, currency: 'AED', amount: '20.00' });
  h.close(1);
  const kinds = h.shard.journal.map((e) => [e.entryId, e.kind, e.amount]);
  assert.deepEqual(kinds, [
    ['d', 'DEBIT', 1000], ['ch', 'CHARGE', 2000], ['VAT:ch', 'VAT', 100],
    ['FEE:ACC-001:D1', 'FEE', 2500], ['VAT:FEE:ACC-001:D1', 'VAT', 125],
  ]);
  assert.equal(h.shard.closingBalance(A, 1), -(1000 + 2000 + 100 + 2500 + 125));
  // partial refund of the fee refunds VAT pro rata; the rest follows exactly
  h.ev({ id: 'rf1', day: 2, type: 'REFUND', account: A, currency: 'AED', refersTo: 'FEE:ACC-001:D1', amount: '10.00' });
  h.ev({ id: 'rf2', day: 2, type: 'REFUND', account: A, refersTo: 'FEE:ACC-001:D1' });
  const back = h.shard.journal.filter((e) => e.eventId === 'rf1' || e.eventId === 'rf2').map((e) => [e.entryId, e.kind, e.amount]);
  assert.deepEqual(back, [['rf1', 'REFUND', 1000], ['VAT:rf1', 'VAT_REFUND', 50], ['rf2', 'REFUND', 1500], ['VAT:rf2', 'VAT_REFUND', 75]]);
  const vatGl = h.shard.journal.filter((e) => e.kind.startsWith('VAT')).every((e) => (e.direction === 'DEBIT' ? e.to : e.from)?.accountNumber === 'GL-2300');
  assert.ok(vatGl, 'VAT entries point at the VAT-payable GL');
});

test('VAT default is off: scenario fees are exactly AED 25.00 with no VAT entry', () => {
  const h = harness();
  h.ev(dr('d', 1, '1.00'));
  h.close(1);
  assert.deepEqual(h.shard.journal.map((e) => e.kind), ['DEBIT', 'FEE']);
});

test('fee is assessed at most once per value day, even if the day is restated again', () => {
  const h = harness();
  h.ev(dr('d', 1, '1.00'));
  h.close(1);
  h.ev(dr('d2', 2, '1.00', { valueDate: 1 }));
  h.close(2);
  const fees = h.shard.journal.filter((e) => e.kind === 'FEE').map((e) => e.valueDate);
  assert.deepEqual(fees, [1, 2]);
});

test('negative BHD balance: no fee is invented (no FX rate); FEE_NOT_CONFIGURED is reported once', () => {
  const h = harness();
  h.ev({ id: 'b', day: 1, type: 'DEBIT', account: B, currency: 'BHD', amount: '1.000' });
  const r1 = h.close(1);
  const r2 = h.close(2);
  assert.deepEqual(r1.errors.map((e) => e.code), ['FEE_NOT_CONFIGURED']);
  assert.equal(r2.errors.length, 1, 'D2 is a new negative day → one report for D2');
  assert.equal(h.shard.journal.filter((e) => e.kind === 'FEE').length, 0);
});

test('interest: negative days accrue nothing; carried rounding beats per-day rounding', () => {
  const h = harness();
  h.ev(cr('c', 1, '41.50'));  // 4150 × 4/10000 = 1.66 fils per day
  h.closeThrough(6);
  const days = h.shard.accruals.filter((a) => a.account === A).map((a) => a.amount);
  // exact cumulative 1.66, 3.32, 4.98, 6.64, 8.30, 9.96 → rounded 2,3,5,7,8,10 → daily 2,1,2,2,1,2
  assert.deepEqual(days, [2, 1, 2, 2, 1, 2]);
  assert.equal(days.reduce((a, b) => a + b, 0), 10, 'per-day rounding would give 2×6 = 12 fils');
  assert.equal(h.shard.journal.find((e) => e.kind === 'INTEREST')?.amount, 10);
});

test('window closes after D6: later events are rejected WINDOW_CLOSED', () => {
  const h = harness();
  h.closeThrough(6);
  assert.equal(h.ev(cr('late', 6, '1.00')).code, 'WINDOW_CLOSED');
});

test('an internal bug is fail-stop: recorded as INTERNAL_ERROR and re-thrown', () => {
  const h = harness();
  assert.throws(() => h.ev(cr('future', 3, '1.00')), /delivered while day 1 is open/);
  assert.equal(h.shard.eventLog.at(-1)?.code, 'INTERNAL_ERROR');
});

test('overflow is refused before any state changes', () => {
  const h = harness();
  h.ev(cr('big', 1, '90000000000000.00'));
  const before = h.shard.bookBalance(A);
  const r = h.ev(cr('big2', 1, '90000000000000.00'));
  assert.equal(r.code, 'AMOUNT_OVERFLOW');
  assert.equal(h.shard.bookBalance(A), before);
});

test('transfer between two ledger accounts: two legs, shared transferId, each shows the other as counterparty', () => {
  const h = harness({ accounts: [
    { id: 'ACC-001', currency: 'AED', openingBalance: '100.00', accountName: 'ACC1 Account Name', bankName: 'ACC1 Bank Name' },
    { id: 'ACC-003', currency: 'AED', openingBalance: '0.00', accountName: 'ACC3 Account Name', bankName: 'ACC3 Bank Name' },
  ] });
  h.ev({ id: 'T1-out', day: 1, type: 'DEBIT', account: 'ACC-001', currency: 'AED', amount: '40.00', transferId: 'T1',
    counterparty: { accountNumber: 'ACC-003', accountName: 'ACC3 Account Name', bankName: 'ACC3 Bank Name' } });
  h.ev({ id: 'T1-in', day: 1, type: 'CREDIT', account: 'ACC-003', currency: 'AED', amount: '40.00', transferId: 'T1',
    counterparty: { accountNumber: 'ACC-001', accountName: 'ACC1 Account Name', bankName: 'ACC1 Bank Name' } });
  const [out, inn] = h.shard.journal;
  assert.equal(out.from?.accountNumber, 'ACC-001');
  assert.equal(out.to?.accountNumber, 'ACC-003');
  assert.equal(inn.from?.accountNumber, 'ACC-001');
  assert.equal(inn.to?.accountNumber, 'ACC-003');
  assert.equal(out.transferId, inn.transferId);
  assert.match(out.narration, /\[transfer T1\]/);
});
