/** Human-readable rendering of day-close reports. Pure functions: report in, string out. */
import { format } from './money';
import type { AccountDayReport, DayReport, JournalEntry, Party } from './types';

const fm = (minor: number, ccy: string): string => format(minor, ccy);
const signed = (minor: number, ccy: string): string => (minor > 0 ? '+' : '') + fm(minor, ccy);

function partyShort(p: Party | null): string {
  if (!p) return '—';
  return `${p.accountNumber}${p.accountName ? ` / ${p.accountName}` : ''}${p.bankName ? ` / ${p.bankName}` : ''}`;
}

function renderAccount(a: AccountDayReport, day: number, out: string[]): void {
  const c = a.currency;
  out.push(`  ${a.account} (${c}) ${a.party ? `— ${a.party.accountName ?? ''}, ${a.party.bankName ?? ''}` : ''}`);
  out.push(`    Closing ledger balance D${day}: ${fm(a.closing, c)}`
    + (a.capitalized ? `   (before capitalization ${fm(a.preCapitalization!, c)})` : '')
    + `   | active holds ${fm(a.holds, c)} | available ${fm(a.available, c)}`);

  if (a.restated.length) {
    out.push('    Restated earlier days (back-valued postings):');
    for (const r of a.restated) {
      out.push(r.feeAssessedNow
        ? `      D${r.valueDate}: was ${fm(r.before, c)} → ${fm(r.preFee, c)} before fee → now ${fm(r.after, c)} after fee`
        : `      D${r.valueDate}: was ${fm(r.before, c)} → now ${fm(r.after, c)}`);
    }
  }

  if (a.fees.length === 0) out.push('    Fee assessments: none');
  else {
    out.push(`    Fee assessments (${a.fees.length}):`);
    for (const f of a.fees) {
      out.push(`      ${f.entryId}  DEBIT ${fm(f.amount, c)}${f.vat ? ` + VAT ${fm(f.vat, c)} (separate entry)` : ''}`
        + `  value D${f.valueDate}, posted D${f.postingDate}  (day balance before fee ${fm(f.preFeeBalance, c)})`);
    }
  }

  const acc = a.accruals.filter((x) => x.amount !== 0 || x.kind === 'ACCRUAL');
  if (acc.length) {
    out.push(`    Interest accrual records (accrued to date ${fm(a.accruedToDate, c)}):`);
    for (const x of acc) out.push(`      value D${x.valueDate} ${x.kind.padEnd(18)} ${signed(x.amount, c)}`);
  }
  if (a.capitalized !== null) {
    out.push(`    Interest capitalized: ${fm(a.capitalized, c)} (= Σ of all accrual records, exact)`);
  }

  if (a.auths.length === 0) out.push('    Authorizations: none');
  else {
    out.push('    Authorizations:');
    for (const x of a.auths) {
      let s = `      ${x.authId} (${x.eventId}) ${x.state.padEnd(8)} hold ${fm(x.amount, c)} requested D${x.requestedDay}`;
      if (x.state === 'DECLINED') s += ` — available after hold would be ${fm(x.availableAfter, c)}`;
      if (x.state === 'APPROVED') s += ' — hold active (reduces available, not ledger)';
      if (x.state === 'SETTLED') s += ` — settled ${fm(x.settledAmount, c)} by ${x.settledBy}, released ${fm(x.releasedAmount, c)}`;
      if (x.changedToday) s += '  [changed today]';
      out.push(s);
    }
  }

  if (a.entries.length) {
    out.push(`    Journal entries processed today (${a.entries.length}):`);
    for (const e of a.entries) {
      out.push(`      ${e.entryId.padEnd(16)} ${e.kind.padEnd(10)} ${e.direction.padEnd(6)} ${fm(e.amount, c).padStart(12)}`
        + `  posted D${e.postingDate} value D${e.valueDate} processed D${e.processedOnDay}`
        + `${e.refersTo ? `  refersTo ${e.refersTo}` : ''}`);
      out.push(`        from: ${partyShort(e.from)}`);
      out.push(`        to:   ${partyShort(e.to)}`);
      out.push(`        narration: ${e.narration}`);
    }
  }
}

export function renderDay(r: DayReport, { errorLimit = 25 }: { errorLimit?: number } = {}): string {
  const out: string[] = [];
  out.push('');
  out.push(`════════════════════════ DAY ${r.day} CLOSE ════════════════════════`);
  out.push(`Events processed during D${r.day}: ${r.stats.accepted} accepted, ${r.stats.rejected} rejected`);
  if (r.accounts) {
    for (const a of r.accounts) renderAccount(a, r.day, out);
  }
  const ccys = Object.keys(r.totals).sort();
  if (!r.accounts || r.accounts.length > 2) {
    out.push('  Totals by currency:');
    for (const c of ccys) {
      const t = r.totals[c];
      out.push(`    ${c}: ${t.accounts} accounts, Σ closing ${fm(t.closing, c)}, ${t.negativeAccounts} negative, `
        + `fees ${t.feeCount} (${fm(t.fees, c)}${t.vat ? ` + VAT ${fm(t.vat, c)}` : ''}), accrual net ${signed(t.accrualNet, c)}, `
        + `holds ${fm(t.holds, c)}${t.capitalized ? `, capitalized ${fm(t.capitalized, c)}` : ''}`);
    }
  }
  if (r.errorTotal === 0) out.push('  Errors: none');
  else {
    const counts = Object.entries(r.errorCounts).map(([k, v]) => `${k}×${v}`).join(', ');
    out.push(`  Errors (${r.errorTotal}): ${counts}`);
    for (const e of r.errors.slice(0, errorLimit)) {
      out.push(`    [seq ${e.seq ?? '-'}] ${e.eventId ?? '(system)'} ${e.account ?? ''} ${e.code}: ${e.message}`);
    }
    if (r.errorTotal > Math.min(errorLimit, r.errors.length)) {
      out.push(`    … ${r.errorTotal - Math.min(errorLimit, r.errors.length)} more not shown`);
    }
  }
  if (r.notices.length) {
    out.push(`  Notices (${r.notices.length}):`);
    for (const n of r.notices.slice(0, errorLimit)) out.push(`    [seq ${n.seq}] ${n.eventId} ${n.account} ${n.code}: ${n.message}`);
  }
  return out.join('\n');
}

/** Final restated view: closing balance per value day as known at end of window. */
export function renderFinal(last: DayReport): string {
  if (!last.accounts) return '';
  const out = ['', '════════════════ END OF WINDOW — RESTATED VALUE-DAY BALANCES ════════════════'];
  const days = last.accounts[0] ? last.accounts[0].valueDayBalances.length : 0;
  out.push(`  ${'account'.padEnd(10)} ${Array.from({ length: days }, (_, i) => `D${i + 1}`.padStart(12)).join('')}`);
  for (const a of last.accounts) {
    out.push(`  ${a.account.padEnd(10)} ${a.valueDayBalances.map((b) => fm(b, a.currency).padStart(12)).join('')}`);
  }
  out.push('  (D6 includes the interest capitalization credit)');
  return out.join('\n');
}

/** Account statement across the window: every entry, both directions, never netted. */
export function renderStatement(reports: DayReport[]): string {
  const byAcct = new Map<string, { currency: string; opening: number; entries: JournalEntry[] }>();
  for (const r of reports) {
    if (!r.accounts) return '';
    for (const a of r.accounts) {
      if (!byAcct.has(a.account)) byAcct.set(a.account, { currency: a.currency, opening: a.opening, entries: [] });
      byAcct.get(a.account)!.entries.push(...a.entries);
    }
  }
  const out = ['', '════════════════ ACCOUNT STATEMENTS (every entry, debit and credit kept separate) ════════════════'];
  for (const [id, { currency: c, opening, entries }] of byAcct) {
    out.push(`  ${id} (${c})   opening balance ${fm(opening, c)}`);
    out.push(`    ${'entry'.padEnd(20)} ${'kind'.padEnd(10)} ${'posted'.padEnd(6)} ${'value'.padEnd(5)} ${'debit'.padStart(12)} ${'credit'.padStart(12)}  refersTo`);
    let dr = 0; let cr = 0;
    for (const e of entries) {
      const d = e.direction === 'DEBIT';
      if (d) dr += e.amount; else cr += e.amount;
      out.push(`    ${e.entryId.padEnd(20)} ${e.kind.padEnd(10)} ${('D' + e.postingDate).padEnd(6)} ${('D' + e.valueDate).padEnd(5)} `
        + `${(d ? fm(e.amount, c) : '').padStart(12)} ${(d ? '' : fm(e.amount, c)).padStart(12)}  ${e.refersTo ?? ''}`);
    }
    out.push(`    ${'TOTAL'.padEnd(44)} ${fm(dr, c).padStart(12)} ${fm(cr, c).padStart(12)}  movement ${fm(cr - dr, c)}, closing ${fm(opening + cr - dr, c)}`);
  }
  return out.join('\n');
}

