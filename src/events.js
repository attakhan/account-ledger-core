'use strict';
/**
 * Structural validation and normalisation of inbound events. This checks
 * shape only, with no account state involved. Anything that needs the account
 * (currency precision, balances, auth lookups) is checked in the shard.
 */
const { CODES, LedgerError } = require('./errors');

const TYPES = Object.freeze(['CREDIT', 'DEBIT', 'AUTHORIZATION', 'SETTLEMENT', 'REVERSAL', 'RETURN', 'REFUND', 'CHARGE']);
const TYPE_SET = new Set(TYPES);
const NEEDS_AMOUNT = new Set(['CREDIT', 'DEBIT', 'AUTHORIZATION', 'SETTLEMENT', 'RETURN', 'CHARGE']);
const NEEDS_AUTH = new Set(['AUTHORIZATION', 'SETTLEMENT']);
const NEEDS_REF = new Set(['REVERSAL', 'RETURN', 'REFUND']);
const SPLITTABLE = new Set(['CREDIT', 'DEBIT']);

function fail(msg) { throw new LedgerError(CODES.INVALID_EVENT, msg); }

function str(v, name, maxLen) {
  if (typeof v !== 'string' || v.length === 0) fail(`${name} must be a non-empty string`);
  if (v.length > maxLen) fail(`${name} longer than ${maxLen} characters`);
  return v;
}

function int(v, name) {
  if (!Number.isSafeInteger(v)) fail(`${name} must be an integer, got ${JSON.stringify(v)}`);
  return v;
}

const PARTY_FIELDS = ['accountNumber', 'accountName', 'bankName', 'bic', 'iban'];

/** Counterparty block (the other side of the movement). All fields optional, at least one required. */
function normalizeParty(raw, maxLen) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) fail('counterparty must be an object');
  const out = {};
  let n = 0;
  for (const k of Object.keys(raw)) {
    if (!PARTY_FIELDS.includes(k)) fail(`unknown counterparty field ${k}`);
  }
  for (const k of PARTY_FIELDS) {
    if (raw[k] === undefined || raw[k] === null) { out[k] = null; continue; }
    out[k] = str(raw[k], `counterparty.${k}`, maxLen);
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
function normalizeEvent(raw, policy) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) fail('event must be a JSON object');
  const maxLen = policy.maxIdLength;
  const id = str(raw.id, 'id', maxLen);
  const day = int(raw.day, 'day');
  const type = raw.type;
  if (!TYPE_SET.has(type)) {
    throw new LedgerError(CODES.UNKNOWN_EVENT_TYPE, `unknown event type ${JSON.stringify(type)}`);
  }
  const account = str(raw.account, 'account', maxLen);
  const currency = raw.currency === undefined ? null : str(raw.currency, 'currency', 3);
  if (currency === null && type !== 'REVERSAL' && type !== 'REFUND') fail(`${type} requires currency`);

  let amount = null;
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

module.exports = { TYPES, PARTY_FIELDS, normalizeEvent, normalizeParty };
