'use strict';

/**
 * Every rejection the ledger can produce. A code is stable API: tests and
 * downstream consumers match on it, never on the message text.
 */
const CODES = Object.freeze({
  INVALID_JSON: 'INVALID_JSON',
  INVALID_EVENT: 'INVALID_EVENT',
  UNKNOWN_EVENT_TYPE: 'UNKNOWN_EVENT_TYPE',
  UNKNOWN_ACCOUNT: 'UNKNOWN_ACCOUNT',
  CURRENCY_MISMATCH: 'CURRENCY_MISMATCH',
  INVALID_AMOUNT: 'INVALID_AMOUNT',
  AMOUNT_PRECISION: 'AMOUNT_PRECISION',
  AMOUNT_OVERFLOW: 'AMOUNT_OVERFLOW',
  DUPLICATE_EVENT: 'DUPLICATE_EVENT',
  OUT_OF_WINDOW: 'OUT_OF_WINDOW',
  VALUE_DATE_IN_FUTURE: 'VALUE_DATE_IN_FUTURE',
  VALUE_DATE_TOO_OLD: 'VALUE_DATE_TOO_OLD',
  WINDOW_CLOSED: 'WINDOW_CLOSED',
  DUPLICATE_AUTH_ID: 'DUPLICATE_AUTH_ID',
  SETTLEMENT_UNKNOWN_AUTH: 'SETTLEMENT_UNKNOWN_AUTH',
  SETTLEMENT_AUTH_DECLINED: 'SETTLEMENT_AUTH_DECLINED',
  SETTLEMENT_AUTH_ALREADY_SETTLED: 'SETTLEMENT_AUTH_ALREADY_SETTLED',
  SETTLEMENT_EXCEEDS_AUTH: 'SETTLEMENT_EXCEEDS_AUTH',
  REFERENCE_NOT_FOUND: 'REFERENCE_NOT_FOUND',
  REFERENCE_NOT_ELIGIBLE: 'REFERENCE_NOT_ELIGIBLE',
  ALREADY_REVERSED: 'ALREADY_REVERSED',
  REVERSAL_AFTER_PARTIAL_REFUND: 'REVERSAL_AFTER_PARTIAL_REFUND',
  REVERSAL_AMOUNT_MISMATCH: 'REVERSAL_AMOUNT_MISMATCH',
  REFUND_EXCEEDS_REMAINING: 'REFUND_EXCEEDS_REMAINING',
  VALUE_DATE_BEFORE_ORIGINAL: 'VALUE_DATE_BEFORE_ORIGINAL',
  FEE_NOT_CONFIGURED: 'FEE_NOT_CONFIGURED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
});

class LedgerError extends Error {
  constructor(code, message, details) {
    // Business rejections are expected at volume (orphan settlements, duplicates…).
    // Capturing a stack for each one was ~10% of replay CPU in profiling, and the
    // stack carries no information for a rejection, so it is skipped.
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 0;
    super(message);
    Error.stackTraceLimit = limit;
    this.name = 'LedgerError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/** Unexpected invariant break — a bug, never a business rejection. */
class InvariantError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'InvariantError';
    if (details !== undefined) this.details = details;
  }
}

module.exports = { CODES, LedgerError, InvariantError };
