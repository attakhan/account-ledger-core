/**
 * Every tunable in one place. NUMBERS.md explains each value, why it was
 * chosen, and why it is not half that value. Business constants are strings
 * or integer rationals and are never floats.
 */
import type { Policy } from './types';

export const DEFAULT_POLICY: Policy = Object.freeze({
  window: Object.freeze({ firstDay: 1, lastDay: 6 }),

  // Overdraft fee per account currency. Only AED is specified. There is no FX
  // rate, so BHD has no fee: a negative BHD day raises FEE_NOT_CONFIGURED.
  overdraftFee: Object.freeze({ AED: '25.00' }),

  // VAT on charges (overdraft fee, CHARGE events), in basis points per
  // currency, posted as a SEPARATE entry. 0 by default: the brief fixes the fee
  // at AED 25.00 and says nothing about VAT. UAE's standard rate would be 500.
  vatBps: Object.freeze({ AED: 0, BHD: 0 }),

  // 0.04 % per day = 4 / 10 000. Held as an integer rational to keep floats out.
  interestRate: Object.freeze({ num: 4, den: 10_000 }),

  // Accruals capitalize at the end of this day (the last day of the window).
  capitalizeOnDay: 6,

  // How far back a value date may reach, measured from the posting day.
  // null means anywhere inside the window (the scenario needs 3 days: E7 posted D5, value D2).
  maxBackValueDays: null,

  // A settlement may exceed its authorization hold by this many basis points.
  // 0 means a settlement above the hold is rejected (SETTLEMENT_EXCEEDS_AUTH).
  settlementOverToleranceBps: 0,

  // Instalment count bounds for split postings (E10 uses 3).
  maxInstalments: 1_000,

  maxIdLength: 64,
  // Max length of any counterparty text field (SWIFT MT103 name lines are 4×35 = 140).
  maxPartyFieldLength: 140,

  // The ledger's own internal accounts. They appear as the counterparty on
  // system entries: fees, VAT and interest. The bank name is fictional.
  bank: Object.freeze({
    bankName: 'Ledger Core Bank',
    bic: null,
    gl: Object.freeze({
      FEE_INCOME: Object.freeze({ accountNumber: 'GL-4100', accountName: 'Overdraft fee income', bankName: 'Ledger Core Bank' }),
      VAT_PAYABLE: Object.freeze({ accountNumber: 'GL-2300', accountName: 'VAT payable', bankName: 'Ledger Core Bank' }),
      INTEREST_EXPENSE: Object.freeze({ accountNumber: 'GL-5100', accountName: 'Interest expense', bankName: 'Ledger Core Bank' }),
      CHARGE_INCOME: Object.freeze({ accountNumber: 'GL-4200', accountName: 'Service charge income', bankName: 'Ledger Core Bank' }),
    }),
  }),
});

export const DEFAULT_RUNTIME = Object.freeze({
  // Events per postMessage batch from the router to a shard worker.
  batchSize: 2_048,
  // Batches in flight per worker before the router pauses reading (backpressure).
  maxInFlightBatches: 8,
  // Per-account detail in reports is printed only up to this many accounts.
  detailAccountLimit: 50,
  // Individual error lines printed per day (counts per code are always complete).
  errorSampleLimit: 25,
  // HTTP port for bin/serve.
  httpPort: 3000,
});
