import test from 'node:test';
import assert from 'node:assert/strict';
import * as m from '../../src/money';
import { CODES } from '../../src/errors';

const code = (c: string) => (e: unknown): boolean => (e as { code?: string }).code === c;

test('parseAmount: strings to minor units at each currency precision', () => {
  assert.equal(m.parseAmount('1,200.00', 'AED'), 120000);
  assert.equal(m.parseAmount('1200', 'AED'), 120000);
  assert.equal(m.parseAmount('0.5', 'AED'), 50);
  assert.equal(m.parseAmount('10.000', 'BHD'), 10000);
  assert.equal(m.parseAmount('3.3', 'BHD'), 3300);
});

test('parseAmount: excess precision is rejected, never rounded', () => {
  assert.throws(() => m.parseAmount('1.005', 'AED'), code(CODES.AMOUNT_PRECISION));
  assert.throws(() => m.parseAmount('1.0001', 'BHD'), code(CODES.AMOUNT_PRECISION));
});

test('parseAmount: floats, negatives, junk and overflow are rejected', () => {
  assert.throws(() => m.parseAmount(12.5, 'AED'), code(CODES.INVALID_AMOUNT));
  assert.throws(() => m.parseAmount('-5.00', 'AED'), code(CODES.INVALID_AMOUNT));
  assert.throws(() => m.parseAmount('1e3', 'AED'), code(CODES.INVALID_AMOUNT));
  assert.throws(() => m.parseAmount('12,34.00', 'AED'), code(CODES.INVALID_AMOUNT));
  assert.throws(() => m.parseAmount('999999999999999.00', 'AED'), code(CODES.AMOUNT_OVERFLOW));
  assert.throws(() => m.parseAmount('1.00', 'USD'), code(CODES.INVALID_EVENT));
});

test('format round-trips and signs', () => {
  assert.equal(m.format(120000, 'AED'), '1,200.00');
  assert.equal(m.format(-37000, 'AED'), '-370.00');
  assert.equal(m.format(5, 'AED'), '0.05');
  assert.equal(m.format(10008, 'BHD'), '10.008');
  assert.equal(m.format(8, 'BHD'), '0.008');
});

test('divRoundHalfEven: ties go to even, both signs, exact integers only', () => {
  assert.equal(m.divRoundHalfEven(5, 10), 0);   // 0.5 → 0
  assert.equal(m.divRoundHalfEven(15, 10), 2);  // 1.5 → 2
  assert.equal(m.divRoundHalfEven(25, 10), 2);  // 2.5 → 2
  assert.equal(m.divRoundHalfEven(26, 10), 3);
  assert.equal(m.divRoundHalfEven(-25, 10), -2);
  assert.equal(m.divRoundHalfEven(-26, 10), -3);
  assert.equal(m.divRoundHalfEven(606000, 10000), 61); // 60.6
  assert.equal(m.divRoundHalfEven(762000, 10000), 76); // 76.2
  assert.equal(m.divRoundHalfEven(2 ** 52 + 1, 2), 2 ** 51);     // x.5 with even floor → stays
  assert.equal(m.divRoundHalfEven(2 ** 52 + 3, 2), 2 ** 51 + 2); // x.5 with odd floor → up
  assert.equal(m.divRoundHalfEven(2 ** 53 - 1, 10000), 900719925474); // near the safe-integer ceiling
});

test('allocateEqual: 10.000 BHD / 3 = 3.334 + 3.333 + 3.333 (sums exactly)', () => {
  const parts = m.allocateEqual(10000, 3);
  assert.deepEqual(parts, [3334, 3333, 3333]);
  assert.equal(parts.reduce((a, b) => a + b, 0), 10000);
  // the rejected criterion's version would create money:
  assert.equal(3334 * 3, 10002);
  assert.deepEqual(m.allocateEqual(10, 4), [3, 3, 2, 2]);
  assert.throws(() => m.allocateEqual(2, 3), code(CODES.INVALID_AMOUNT));
});
