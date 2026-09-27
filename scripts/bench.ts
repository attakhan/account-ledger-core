#!/usr/bin/env node
/**
 * Throughput/memory benchmark. Generates a synthetic stream (if missing) and
 * replays it in-process and with 1..N shards through the real CLI.
 *   node dist/scripts/bench.js [--accounts 100000] [--events 1000000] [--max-shards 2]
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import * as os from 'node:os';
import { DIST_ROOT, REPO_ROOT } from '../src/paths';

const arg = (k: string, d: number): number => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? Number(process.argv[i + 1]) : d; };
const ACC = arg('accounts', 100_000);
const EVT = arg('events', 1_000_000);
const MAX = arg('max-shards', Math.max(1, os.availableParallelism() - 1));
const dir = path.join(REPO_ROOT, 'bench-out', `a${ACC}-e${EVT}`);
if (!fs.existsSync(path.join(dir, 'events.ndjson'))) {
  execFileSync(process.execPath, [path.join(__dirname, 'gen-load.js'), '--accounts', String(ACC), '--events', String(EVT), '--out', dir], { stdio: 'inherit' });
}
console.log(`node ${process.version}, ${os.availableParallelism()} CPUs, ${ACC} accounts, ${EVT} events`);
for (let s = 0; s <= MAX; s++) {
  const r = spawnSync(process.execPath, [path.join(DIST_ROOT, 'bin', 'replay.js'), path.join(dir, 'events.ndjson'),
    '--accounts', path.join(dir, 'accounts.json'), '--quiet', '--shards', String(s)], { encoding: 'utf8' });
  if (r.status !== 0) { console.error(r.stderr); process.exit(1); }
  console.log(`${s === 0 ? 'in-process' : `${s} shard(s)`}`.padEnd(12), r.stderr.trim());
}
