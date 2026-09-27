#!/usr/bin/env node
'use strict';
/**
 * Throughput/memory benchmark. Generates a synthetic stream (if missing) and
 * replays it in-process and with 1..N shards through the real CLI.
 *   node scripts/bench.js [--accounts 100000] [--events 1000000] [--max-shards 2]
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const os = require('node:os');

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? Number(process.argv[i + 1]) : d; };
const ACC = arg('accounts', 100_000);
const EVT = arg('events', 1_000_000);
const MAX = arg('max-shards', Math.max(1, os.availableParallelism() - 1));
const root = path.join(__dirname, '..');
const dir = path.join(root, 'bench-out', `a${ACC}-e${EVT}`);
if (!fs.existsSync(path.join(dir, 'events.ndjson'))) {
  execFileSync(process.execPath, [path.join(__dirname, 'gen-load.js'), '--accounts', String(ACC), '--events', String(EVT), '--out', dir], { stdio: 'inherit' });
}
console.log(`node ${process.version}, ${os.availableParallelism()} CPUs, ${ACC} accounts, ${EVT} events`);
for (let s = 0; s <= MAX; s++) {
  const r = spawnSync(process.execPath, [path.join(root, 'bin', 'replay.js'), path.join(dir, 'events.ndjson'),
    '--accounts', path.join(dir, 'accounts.json'), '--quiet', '--shards', String(s)], { encoding: 'utf8' });
  if (r.status !== 0) { console.error(r.stderr); process.exit(1); }
  console.log(`${s === 0 ? 'in-process' : `${s} shard(s)`}`.padEnd(12), r.stderr.trim());
}
