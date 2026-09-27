/**
 * Structural validation and normalisation of inbound events. This checks
 * shape only, with no account state involved. Anything that needs the account
 * (currency precision, balances, auth lookups) is checked in the shard.
 */
import { CODES, LedgerError } from './errors';
import type { EventType, NormalizedEvent, Party, Policy } from './types';

export const TYPES: readonly EventType[] = Object.freeze(['CREDIT', 'DEBIT', 'AUTHORIZATION', 'SETTLEMENT', 'REVERSAL', 'RETURN', 'REFUND', 'CHARGE'] as const);
const TYPE_SET: ReadonlySet<unknown> = new Set(TYPES);
const NEEDS_AMOUNT: ReadonlySet<EventType> = new Set(['CREDIT', 'DEBIT', 'AUTHORIZATION', 'SETTLEMENT', 'RETURN', 'CHARGE']);
const NEEDS_AUTH: ReadonlySet<EventType> = new Set(['AUTHORIZATION', 'SETTLEMENT']);
const NEEDS_REF: ReadonlySet<EventType> = new Set(['REVERSAL', 'RETURN', 'REFUND']);
const SPLITTABLE: ReadonlySet<EventType> = new Set(['CREDIT', 'DEBIT']);

function fail(msg: string): never { throw new LedgerError(CODES.INVALID_EVENT, msg); }

function str(v: unknown, name: string, maxLen: number): string {
  if (typeof v !== 'string' || v.length === 0) fail(`${name} must be a non-empty string`);
  if (v.length > maxLen) fail(`${name} longer than ${maxLen} characters`);
  return v;
}

function int(v: unknown, name: string): number {
  if (!Number.isSafeInteger(v)) fail(`${name} must be an integer, got ${JSON.stringify(v)}`);
  return v as number;
}

export const PARTY_FIELDS = ['accountNumber', 'accountName', 'bankName', 'bic', 'iban'] as const;
type PartyField = (typeof PARTY_FIELDS)[number];

/** Counterparty block (the other side of the movement). All fields optional, at least one required. */
export function normalizeParty(raw: unknown, maxLen: number): Party | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) fail('counterparty must be an object');
  const src = raw as Record<string, unknown>;
  const out: Partial<Record<PartyField, string | null>> = {};
  let n = 0;
  for (const k of Object.keys(src)) {
    if (!(PARTY_FIELDS as readonly string[]).includes(k)) fail(`unknown counterparty field ${k}`);
  }
  for (const k of PARTY_FIELDS) {
    if (src[k] === undefined || src[k] === null) { out[k] = null; continue; }
    out[k] = str(src[k], `counterparty.${k}`, maxLen);
    n++;
  }
  if (n === 0) fail('counterparty has no fields');
  return Object.freeze(out);
}

/**
 * @returns a frozen normalised event:
 * { id, day, type, account, currency|null, amount|null (raw string), valueDate,
 *   authId|null, ref|null, instalments }
 */
export function normalizeEvent(input: unknown, policy: Policy): NormalizedEvent {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) fail('event must be a JSON object');
  const raw = input as Record<string, unknown>;
  const maxLen = policy.maxIdLength;
  const id = str(raw.id, 'id', maxLen);
  const day = int(raw.day, 'day');
  if (!TYPE_SET.has(raw.type)) {
    throw new LedgerError(CODES.UNKNOWN_EVENT_TYPE, `unknown event type ${JSON.stringify(raw.type)}`);
  }
  const type = raw.type as EventType;
  const account = str(raw.account, 'account', maxLen);
  const currency = raw.currency === undefined ? null : str(raw.currency, 'currency', 3);
  if (currency === null && type !== 'REVERSAL' && type !== 'REFUND') fail(`${type} requires currency`);

  let amount: string | null = null;
  if (raw.amount !== undefined) {
    if (typeof raw.amount !== 'string') {
      throw new LedgerError(CODES.INVALID_AMOUNT, 'amount must be a decimal string (floats are refused)');
    }
    amount = raw.amount;
  }
  if (NEEDS_AMOUNT.has(type) && amount === null) fail(`${type} requires amount`);

  const valueDate = raw.valueDate === undefined ? day : int(raw.valueDate, 'valueDate');

  const authId = raw.authId === undefined ? null : str(raw.authId, 'authId', maxLen);
  if (NEEDS_AUTH.has(type) && authId === null) fail(`${type} requires authId`);

  const refRaw = raw.reverses !== undefined ? raw.reverses : raw.refersTo;
  const ref = refRaw === undefined ? null : str(refRaw, 'reverses/refersTo', maxLen * 2);
  if (NEEDS_REF.has(type) && ref === null) fail(`${type} requires reverses/refersTo`);

  let instalments = 1;
  if (raw.instalments !== undefined) {
    if (!SPLITTABLE.has(type)) fail(`instalments not allowed on ${type}`);
    instalments = int(raw.instalments, 'instalments');
    if (instalments < 1 || instalments > policy.maxInstalments) {
      fail(`instalments must be 1..${policy.maxInstalments}`);
    }
  }
  // The other side may be given as `counterparty`, or as `from` (money coming in)
  // / `to` (money going out). The account's own side is filled in by the shard.
  const partyRaw = raw.counterparty ?? raw.from ?? raw.to;
  const counterparty = normalizeParty(partyRaw, policy.maxPartyFieldLength);
  const transferId = raw.transferId === undefined ? null : str(raw.transferId, 'transferId', maxLen);

  return Object.freeze({ id, day, type, account, currency, amount, valueDate, authId, ref, instalments, counterparty, transferId });
}
