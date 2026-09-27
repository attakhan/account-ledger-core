'use strict';
/** Merge per-shard day reports into one deterministic report (order-independent of shard count). */
const bySeq = (a, b) => (a.seq ?? Infinity) - (b.seq ?? Infinity) || String(a.account).localeCompare(String(b.account));

function mergeReports(parts) {
  const out = {
    day: parts[0].day,
    accounts: parts.some((p) => p.accounts) ? [] : null,
    totals: Object.create(null),
    errors: [],
    errorCounts: Object.create(null),
    errorTotal: 0,
    notices: [],
    stats: { accepted: 0, rejected: 0 },
  };
  for (const p of parts) {
    if (p.day !== out.day) throw new Error(`shard reports disagree on day: ${p.day} vs ${out.day}`);
    if (p.accounts) out.accounts.push(...p.accounts);
    for (const [ccy, t] of Object.entries(p.totals)) {
      const o = out.totals[ccy] || (out.totals[ccy] = {});
      for (const [k, v] of Object.entries(t)) o[k] = (o[k] || 0) + v;
    }
    out.errors.push(...p.errors);
    for (const [c, n] of Object.entries(p.errorCounts)) out.errorCounts[c] = (out.errorCounts[c] || 0) + n;
    out.errorTotal += p.errorTotal;
    out.notices.push(...p.notices);
    out.stats.accepted += p.stats.accepted;
    out.stats.rejected += p.stats.rejected;
  }
  if (out.accounts) out.accounts.sort((a, b) => (a.account < b.account ? -1 : a.account > b.account ? 1 : 0));
  out.errors.sort(bySeq);
  out.notices.sort(bySeq);
  return out;
}

module.exports = { mergeReports };
