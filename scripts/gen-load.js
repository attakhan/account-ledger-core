#!/usr/bin/env node
'use strict';
/**
 * Deterministic synthetic load for the ledger: N accounts (AED/BHD mix) and M
 * events spread across the 6-day window, in stream order. The mix includes
 * the awkward cases on purpose: back-valued debits, auths and settlements
 * (some orphaned, some over the hold), reversals, returns, refunds, charges,
 * instalment credits, late arrivals, duplicate ids and malformed lines.
 *
 *   node scripts/gen-load.js --accounts 100000 --events 1000000 --out bench-out [--seed 42]
 */
const fs = require('node:fs');
const path = require('node:path');

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]]);
  return acc;
}, []));
const N = Number(args.accounts ?? 10_000);
const M = Number(args.events ?? 100_000);
const OUT = args.out ?? 'bench-out';
let seed = Number(args.seed ?? 42) >>> 0;

function rnd() { // mulberry32
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const ri = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

fs.mkdirSync(OUT, { recursive: true });
const accounts = [];
for (let i = 0; i < N; i++) {
  const ccy = i % 10 === 9 ? 'BHD' : 'AED';
  accounts.push({ id: `A${String(i).padStart(7, '0')}`, currency: ccy, openingBalance: ccy === 'AED' ? `${ri(0, 5000)}.00` : `${ri(0, 500)}.000`,
    accountName: `A${i} Account Name`, bankName: `A${i} Bank Name` });
}
fs.writeFileSync(path.join(OUT, 'accounts.json'), JSON.stringify(accounts));

const amt = (ccy, max) => (ccy === 'AED' ? `${ri(1, max)}.${String(ri(0, 99)).padStart(2, '0')}` : `${ri(0, Math.ceil(max / 10))}.${String(ri(1, 999)).padStart(3, '0')}`);
const ws = fs.createWriteStream(path.join(OUT, 'events.ndjson'));
const perDay = Math.ceil(M / 6);
const recent = []; // [acctIdx, eventId, type, authId]
let buf = [];
let written = 0;

function emit(o) { buf.push(typeof o === 'string' ? o : JSON.stringify(o)); written++; }

(async () => {
  for (let k = 0; k < M; k++) {
    const day = Math.min(6, 1 + Math.floor(k / perDay));
    const ai = ri(0, N - 1);
    const a = accounts[ai];
    const id = `X${k}`;
    const r = rnd();
    const cp = { accountNumber: `CP${ri(1, 99999)}`, accountName: 'Counterparty Name', bankName: 'Counterparty Bank' };
    let ev;
    let evAi = ai;
    if (r < 0.30) ev = { id, day, type: 'CREDIT', account: a.id, currency: a.currency, amount: amt(a.currency, 3000), valueDate: day, counterparty: cp };
    else if (r < 0.52) ev = { id, day, type: 'DEBIT', account: a.id, currency: a.currency, amount: amt(a.currency, 2500), valueDate: rnd() < 0.1 ? ri(1, day) : day, counterparty: cp };
    else if (r < 0.67) ev = { id, day, type: 'AUTHORIZATION', account: a.id, currency: a.currency, authId: `AU${k}`, amount: amt(a.currency, 800), valueDate: day };
    else if (r < 0.80) {
      const prev = recent.length ? recent[ri(0, recent.length - 1)] : null;
      const useAuth = prev && prev[2] === 'AUTHORIZATION' && rnd() < 0.9;
      const acct = useAuth ? accounts[prev[0]] : a;
      if (useAuth) evAi = prev[0];
      ev = { id, day, type: 'SETTLEMENT', account: acct.id, currency: acct.currency, authId: useAuth ? prev[3] : `ORPHAN${k}`, amount: amt(acct.currency, 700), valueDate: day };
    } else if (r < 0.85) {
      const prev = recent.length ? recent[ri(0, recent.length - 1)] : null;
      if (prev && (prev[2] === 'DEBIT' || prev[2] === 'CREDIT')) evAi = prev[0], ev = { id, day, type: 'REVERSAL', account: accounts[prev[0]].id, reverses: prev[1], valueDate: day };
      else ev = { id, day, type: 'CHARGE', account: a.id, currency: a.currency, amount: amt(a.currency, 50), valueDate: day };
    } else if (r < 0.89) {
      const prev = recent.length ? recent[ri(0, recent.length - 1)] : null;
      if (prev && prev[2] === 'DEBIT') evAi = prev[0], ev = { id, day, type: rnd() < 0.5 ? 'RETURN' : 'REFUND', account: accounts[prev[0]].id, currency: accounts[prev[0]].currency, refersTo: prev[1], amount: amt(accounts[prev[0]].currency, 100), valueDate: day };
      else ev = { id, day, type: 'CHARGE', account: a.id, currency: a.currency, amount: amt(a.currency, 50), valueDate: day };
    } else if (r < 0.93) ev = { id, day, type: 'CREDIT', account: a.id, currency: a.currency, amount: amt(a.currency, 900), instalments: ri(2, 4), valueDate: day, counterparty: cp };
    else if (r < 0.95 && day > 1) ev = { id, day: day - 1, type: 'CREDIT', account: a.id, currency: a.currency, amount: amt(a.currency, 300), valueDate: day - 1 }; // late arrival
    else if (r < 0.97 && recent.length) { const p = recent[ri(0, recent.length - 1)]; evAi = p[0]; ev = { id: p[1], day, type: 'CREDIT', account: accounts[p[0]].id, currency: accounts[p[0]].currency, amount: '1.00', valueDate: day }; } // duplicate
    else if (r < 0.98) { emit('{"id": broken json'); continue; }
    else ev = { id, day, type: 'DEBIT', account: `UNKNOWN${k}`, currency: 'AED', amount: '1.00', valueDate: day };
    emit(ev);
    if (ev.type !== 'REVERSAL') {
      recent.push([evAi, ev.id, ev.type, ev.authId]);
      if (recent.length > 5000) recent.splice(0, 1000);
    }
    if (buf.length >= 10_000) { if (!ws.write(buf.join('\n') + '\n')) await new Promise((r2) => ws.once('drain', r2)); buf = []; }
  }
  ws.end(buf.join('\n') + (buf.length ? '\n' : ''));
  ws.on('finish', () => process.stderr.write(`wrote ${N} accounts, ${written} lines to ${OUT}/\n`));
})();
