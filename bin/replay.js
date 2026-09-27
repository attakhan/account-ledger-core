#!/usr/bin/env node
'use strict';
/**
 * Replay an NDJSON event stream through the ledger and print, per day:
 * closing ledger balance, fee assessments, authorization states, errors.
 *
 *   node bin/replay.js [events.ndjson] [--accounts data/accounts.json]
 *        [--shards N] [--json] [--summary | --detail] [--vat-bps N] [--quiet]
 *        [--no-journal-retention]   benchmark only: entries are built, reported, then dropped
 *
 * Exit codes: 0 replay completed (business rejections are normal output),
 *             1 fatal (bug / worker crash / unreadable input), 2 bad usage.
 */
const fs = require('node:fs');
const path = require('node:path');
const { replay, inProcess } = require('../src/replay');
const { ShardedEngine } = require('../src/sharded');
const { DEFAULT_POLICY, DEFAULT_RUNTIME } = require('../src/config');
const { renderDay, renderFinal, renderStatement } = require('../src/report');

function usage(msg) {
  if (msg) process.stderr.write(`error: ${msg}\n`);
  process.stderr.write('usage: replay.js [events.ndjson] [--accounts file] [--shards N] [--json] [--summary|--detail] [--vat-bps N] [--quiet] [--no-journal-retention]\n');
  process.exit(2);
}

function parseArgs(argv) {
  const o = { events: null, accounts: null, shards: 0, json: false, detail: null, vatBps: null, quiet: false, retainJournal: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { if (i + 1 >= argv.length) usage(`${a} needs a value`); return argv[++i]; };
    if (a === '--accounts') o.accounts = next();
    else if (a === '--shards') { o.shards = Number(next()); if (!Number.isSafeInteger(o.shards) || o.shards < 0) usage('--shards must be >= 0'); }
    else if (a === '--json') o.json = true;
    else if (a === '--summary') o.detail = false;
    else if (a === '--detail') o.detail = true;
    else if (a === '--quiet') o.quiet = true;
    else if (a === '--no-journal-retention') o.retainJournal = false;
    else if (a === '--vat-bps') { o.vatBps = Number(next()); if (!Number.isSafeInteger(o.vatBps) || o.vatBps < 0) usage('--vat-bps must be a non-negative integer'); }
    else if (a === '-h' || a === '--help') usage();
    else if (a.startsWith('--')) usage(`unknown flag ${a}`);
    else if (o.events === null) o.events = a;
    else usage(`unexpected argument ${a}`);
  }
  const root = path.join(__dirname, '..');
  o.events = o.events ?? path.join(root, 'data', 'scenario.ndjson');
  o.accounts = o.accounts ?? path.join(root, 'data', 'accounts.json');
  return o;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  let accounts;
  try {
    accounts = JSON.parse(fs.readFileSync(o.accounts, 'utf8'));
    if (!Array.isArray(accounts)) throw new Error('accounts file must be a JSON array');
  } catch (e) { process.stderr.write(`fatal: cannot load accounts ${o.accounts}: ${e.message}\n`); process.exit(1); }
  if (!fs.existsSync(o.events)) { process.stderr.write(`fatal: events file not found: ${o.events}\n`); process.exit(1); }

  const policy = o.vatBps === null ? DEFAULT_POLICY
    : Object.freeze({ ...DEFAULT_POLICY, vatBps: Object.freeze({ AED: o.vatBps, BHD: o.vatBps }) });
  const detail = o.detail ?? accounts.length <= DEFAULT_RUNTIME.detailAccountLimit;
  const engine = o.shards > 0
    ? new ShardedEngine({ accounts, shards: o.shards, policy, detail, errorSampleLimit: DEFAULT_RUNTIME.errorSampleLimit,
      retainJournal: o.retainJournal })
    : inProcess(accounts, { policy, detail, errorSampleLimit: DEFAULT_RUNTIME.errorSampleLimit, retainJournal: o.retainJournal });

  const t0 = process.hrtime.bigint();
  const print = (s) => { if (!o.quiet) process.stdout.write(s + '\n'); };
  let result;
  try {
    if (!o.json) {
      print(`Replaying ${path.relative(process.cwd(), o.events) || o.events} — ${accounts.length} accounts, `
        + `${o.shards > 0 ? `${o.shards} worker shards` : 'in-process'}, window D${policy.window.firstDay}–D${policy.window.lastDay}`);
    }
    result = await replay({
      source: o.events, engine, policy,
      keepReports: detail || o.json,
      onDayClosed: (r) => { if (!o.json) print(renderDay(r, { errorLimit: DEFAULT_RUNTIME.errorSampleLimit })); },
    });
  } catch (e) {
    process.stderr.write(`fatal: replay aborted: ${e && e.stack ? e.stack : e}\n`);
    await engine.close().catch(() => {});
    process.exit(1);
  }
  await engine.close();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;

  if (o.json) {
    process.stdout.write(JSON.stringify({ events: result.events, reports: result.reports }, null, 2) + '\n');
    return;
  }
  if (detail && result.reports.length) {
    print(renderFinal(result.reports[result.reports.length - 1]));
    print(renderStatement(result.reports));
  }
  process.stderr.write(`\n${result.events} events replayed in ${ms.toFixed(0)} ms `
    + `(${Math.round(result.events / (ms / 1000)).toLocaleString('en-US')} events/s), `
    + `peak RSS ${(process.resourceUsage().maxRSS / 1024).toFixed(0)} MB\n`);
}

main();
