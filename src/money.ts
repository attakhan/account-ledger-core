/**
 * Money is held as an integer count of the currency's minor unit (fils) in a
 * JS Number. Every arithmetic result passes through `safe()`; a value outside
 * ±(2^53−1) raises AMOUNT_OVERFLOW rather than silently losing precision.
 * No floating-point value ever represents money: parsing goes string → integer
 * and formatting goes integer → string.
 */
import { CODES, LedgerError } from './errors';

export interface CurrencyInfo { readonly code: string; readonly precision: number }

export const CURRENCIES: Readonly<Record<string, CurrencyInfo>> = Object.freeze({
  AED: Object.freeze({ code: 'AED', precision: 2 }),
  BHD: Object.freeze({ code: 'BHD', precision: 3 }),
});

export function currencyInfo(code: string): CurrencyInfo {
  const c = CURRENCIES[code];
  if (!c) throw new LedgerError(CODES.INVALID_EVENT, `unsupported currency ${code}`);
  return c;
}

export function safe(n: number): number {
  if (!Number.isSafeInteger(n)) {
    throw new LedgerError(CODES.AMOUNT_OVERFLOW, `amount ${n} exceeds safe integer range`);
  }
  return n;
}

export const add = (a: number, b: number): number => safe(a + b);
export const sub = (a: number, b: number): number => safe(a - b);

const AMOUNT_RE = /^(-)?(\d{1,15})(?:\.(\d+))?$/;

/**
 * Parse a decimal string ("1200.00", "1,200.00", "10.000") into minor units.
 * Input with more fractional digits than the currency allows is REJECTED, not
 * rounded: silently rounding an inbound instruction would move money that was
 * never instructed. Numbers (not strings) are refused to keep float out.
 */
export function parseAmount(raw: unknown, currency: string, { allowNegative = false }: { allowNegative?: boolean } = {}): number {
  const { precision } = currencyInfo(currency);
  if (typeof raw !== 'string') {
    throw new LedgerError(CODES.INVALID_AMOUNT, `amount must be a decimal string, got ${typeof raw}`);
  }
  const cleaned = raw.trim().replace(/,(?=\d{3}(\D|$))/g, '');
  const m = AMOUNT_RE.exec(cleaned);
  if (!m) throw new LedgerError(CODES.INVALID_AMOUNT, `malformed amount "${raw}"`);
  const [, neg, whole, frac = ''] = m;
  if (frac.length > precision) {
    throw new LedgerError(CODES.AMOUNT_PRECISION,
      `amount "${raw}" has ${frac.length} decimals; ${currency} allows ${precision}`);
  }
  const minor = safe(Number(whole) * 10 ** precision + Number(frac.padEnd(precision, '0') || '0'));
  if (neg && !allowNegative) throw new LedgerError(CODES.INVALID_AMOUNT, `negative amount "${raw}"`);
  return neg ? -minor : minor;
}

/** Display format with thousands separators: 120000 AED → "1,200.00". */
export function format(minor: number, currency: string): string {
  const { precision } = currencyInfo(currency);
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  const s = String(abs).padStart(precision + 1, '0');
  const whole = s.slice(0, s.length - precision).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}${whole}.${s.slice(s.length - precision)}`;
}

/** Machine format, no grouping, parseable by parseAmount: 120000 AED → "1200.00". */
export function toDecimal(minor: number, currency: string): string {
  const { precision } = currencyInfo(currency);
  const sign = minor < 0 ? '-' : '';
  const s = String(Math.abs(minor)).padStart(precision + 1, '0');
  return `${sign}${s.slice(0, s.length - precision)}.${s.slice(s.length - precision)}`;
}

/**
 * Round the exact rational num/den (integers, den > 0) to an integer using
 * round-half-to-even. Pure integer arithmetic; no float division is trusted.
 */
export function divRoundHalfEven(num: number, den: number): number {
  safe(num); safe(den);
  if (den <= 0) throw new RangeError('den must be positive');
  let q = Math.trunc(num / den);
  let r = num - q * den; // exact: |num| < 2^53 and q*den is exact integer
  // Math.trunc on a float quotient can be off by one for large operands: correct it.
  while (r < 0 && num >= 0) { q -= 1; r += den; }
  while (r >= den) { q += 1; r -= den; }
  if (num < 0) {
    // Mirror so the same half-even rule applies symmetrically.
    return -divRoundHalfEven(-num, den);
  }
  const twice = 2 * r;
  if (twice > den) return q + 1;
  if (twice < den) return q;
  return q % 2 === 0 ? q : q + 1;
}

/**
 * Split `total` minor units into `parts` near-equal integer pieces that sum
 * exactly to `total`. The indivisible remainder goes one unit each to the
 * earliest pieces (largest-remainder method), e.g. 10000 / 3 → [3334, 3333, 3333].
 */
export function allocateEqual(total: number, parts: number): number[] {
  if (!Number.isSafeInteger(parts) || parts < 1) {
    throw new LedgerError(CODES.INVALID_EVENT, `instalments must be a positive integer, got ${parts}`);
  }
  if (total < parts) {
    throw new LedgerError(CODES.INVALID_AMOUNT,
      `cannot split ${total} minor units into ${parts} non-zero instalments`);
  }
  const base = Math.floor(total / parts);
  const rem = total - base * parts;
  const out = new Array<number>(parts);
  for (let i = 0; i < parts; i++) out[i] = base + (i < rem ? 1 : 0);
  return out;
}
