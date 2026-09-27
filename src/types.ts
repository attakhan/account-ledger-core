/**
 * Shared shapes. Money is always an integer count of the currency's minor
 * unit (see money.ts); days are integers inside the policy window.
 */

export type Direction = 'DEBIT' | 'CREDIT';

export type EventType = 'CREDIT' | 'DEBIT' | 'AUTHORIZATION' | 'SETTLEMENT' | 'REVERSAL' | 'RETURN' | 'REFUND' | 'CHARGE';

export type EntryKind =
  | 'CREDIT' | 'DEBIT' | 'CHARGE' | 'SETTLEMENT' | 'REVERSAL' | 'RETURN' | 'REFUND'
  | 'FEE' | 'INTEREST' | 'VAT' | 'VAT_REVERSAL' | 'VAT_REFUND';

/** From/to block on a journal entry. Every field is optional; GL parties carry only three. */
export interface Party {
  readonly accountNumber?: string | null;
  readonly accountName?: string | null;
  readonly bankName?: string | null;
  readonly bic?: string | null;
  readonly iban?: string | null;
}

export type GlAccount = 'FEE_INCOME' | 'VAT_PAYABLE' | 'INTEREST_EXPENSE' | 'CHARGE_INCOME';

export interface Policy {
  readonly window: { readonly firstDay: number; readonly lastDay: number };
  readonly overdraftFee: Readonly<Record<string, string>>;
  readonly vatBps: Readonly<Record<string, number>>;
  readonly interestRate: { readonly num: number; readonly den: number };
  readonly capitalizeOnDay: number;
  readonly maxBackValueDays: number | null;
  readonly settlementOverToleranceBps: number;
  readonly maxInstalments: number;
  readonly maxIdLength: number;
  readonly maxPartyFieldLength: number;
  readonly bank: {
    readonly bankName: string;
    readonly bic: string | null;
    readonly gl: Readonly<Record<GlAccount, Party>>;
  };
}

/** One entry of the accounts file. */
export interface AccountConfig {
  id: string;
  currency: string;
  openingBalance?: string;
  accountName?: string;
  bankName?: string;
  bic?: string;
  iban?: string;
}

/** Output of events.normalizeEvent. */
export interface NormalizedEvent {
  readonly id: string;
  readonly day: number;
  readonly type: EventType;
  readonly account: string;
  readonly currency: string | null;
  readonly amount: string | null;
  readonly valueDate: number;
  readonly authId: string | null;
  readonly ref: string | null;
  readonly instalments: number;
  readonly counterparty: Party | null;
  readonly transferId: string | null;
}

export interface JournalEntry {
  readonly entryId: string;
  readonly eventId: string | null;
  readonly account: string;
  readonly currency: string;
  readonly kind: EntryKind;
  readonly direction: Direction;
  readonly amount: number;
  readonly postingDate: number;
  readonly valueDate: number;
  readonly processedOnDay: number;
  readonly refersTo: string | null;
  readonly authId: string | null;
  readonly instalment: string | null;
  readonly transferId: string | null;
  readonly from: Party | null;
  readonly to: Party | null;
  readonly narration: string;
}

export type AccrualKind = 'ACCRUAL' | 'ACCRUAL_ADJUSTMENT';

export interface AccrualRecord {
  readonly accrualId: string;
  readonly account: string;
  readonly currency: string;
  readonly valueDate: number;
  readonly postingDate: number;
  readonly amount: number;
  readonly kind: AccrualKind;
  readonly exactCumulative: string;
  readonly narration: string;
}

/** A report row for accruals: a full record, or a zero placeholder for the day. */
export type AccrualView = AccrualRecord | { valueDate: number; postingDate: number; amount: number; kind: AccrualKind };

export interface EventLogRecord {
  readonly seq: number | null;
  readonly eventId: string | null;
  readonly type: string | null;
  readonly account: string | null;
  readonly postingDate: number | null;
  readonly processedOnDay: number;
  readonly status: 'ACCEPTED' | 'REJECTED';
  readonly code: string | null;
  readonly outcome: string | null;
  readonly narration: string;
}

export interface ApplyResult {
  status: 'ACCEPTED' | 'REJECTED';
  outcome?: string;
  narration?: string;
  code?: string;
  message?: string;
}

export type AuthState = 'APPROVED' | 'DECLINED' | 'SETTLED';

export interface AuthHistory { readonly day: number; readonly state: AuthState; readonly eventId: string }

export interface Authorization {
  authId: string;
  eventId: string;
  seq: number;
  amount: number;
  requestedDay: number;
  valueDate: number;
  state: AuthState;
  availableAfter: number;
  settledAmount: number;
  releasedAmount: number;
  settledBy: string | null;
  history: AuthHistory[];
  counterparty: Party | null;
}

export interface AuthView {
  authId: string;
  eventId: string;
  state: AuthState;
  amount: number;
  requestedDay: number;
  availableAfter: number;
  settledAmount: number;
  releasedAmount: number;
  settledBy: string | null;
  changedToday: boolean;
}

export interface FeeAssessment {
  entryId: string;
  valueDate: number;
  postingDate: number;
  amount: number;
  vat: number;
  preFeeBalance: number;
}

export interface Restatement {
  valueDate: number;
  before: number;
  preFee: number;
  after: number;
  feeAssessedNow: boolean;
}

export interface AccountDayReport {
  account: string;
  currency: string;
  party: Party;
  opening: number;
  closing: number;
  preCapitalization: number | null;
  holds: number;
  available: number;
  fees: FeeAssessment[];
  accruals: AccrualView[];
  accruedToDate: number;
  restated: Restatement[];
  capitalized: number | null;
  auths: AuthView[];
  entries: JournalEntry[];
  valueDayBalances: number[];
}

export interface CurrencyTotals {
  accounts: number;
  closing: number;
  negativeAccounts: number;
  fees: number;
  feeCount: number;
  vat: number;
  accrualNet: number;
  capitalized: number;
  holds: number;
}

export interface ErrorSample {
  seq: number | null;
  eventId: string | null;
  account: string | null;
  code: string;
  message: string;
}

export interface Notice {
  seq: number;
  eventId: string;
  account: string;
  code: 'LATE_ARRIVAL' | 'BACK_VALUED';
  message: string;
}

export interface DayStats { accepted: number; rejected: number }

export interface DayReport {
  day: number;
  accounts: AccountDayReport[] | null;
  totals: Record<string, CurrencyTotals>;
  errors: ErrorSample[];
  errorCounts: Record<string, number>;
  errorTotal: number;
  notices: Notice[];
  stats: DayStats;
}

/** What the replayer drives: one in-process shard, or a pool of worker shards. */
export interface Engine {
  apply(raw: unknown, seq: number, line?: string | null): void | Promise<void>;
  rejectRaw(seq: number, code: string, message: string): void | Promise<void>;
  closeDay(day: number): Promise<DayReport>;
  close(): Promise<void>;
}
