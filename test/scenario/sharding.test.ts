/**
 * Determinism across execution modes: the same stream must produce identical
 * day reports whether it runs in-process or across N worker shards.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SCENARIO, ACCOUNTS, DIST, runSharded } from '../helpers';
import { replay, inProcess, type ReplaySource } from '../../src/replay';
import { fnv1a } from '../../src/sharded';
import type { AccountConfig } from '../../src/types';

async function inProc(source: ReplaySource, accounts: AccountConfig[], detail: boolean) {
  const engine = inProcess(accounts, { detail, errorSampleLimit: Infinity });
  return (await replay({ source, engine })).reports;
}

test('scenario: in-process ≡ 2 shards ≡ 3 shards (full detail)', async () => {
  const base = JSON.stringify(await inProc(SCENARIO, ACCOUNTS, true));
  for (const n of [2, 3]) {
    assert.equal(JSON.stringify(await runSharded({ shards: n, source: SCENARIO })), base, `${n} shards`);
  }
});

test('synthetic 20k-event stream with every awkward case: in-process ≡ 2 shards', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
  execFileSync(process.execPath, [path.join(DIST, 'scripts', 'gen-load.js'), '--accounts', '300', '--events', '20000', '--out', dir, '--seed', '7'],
    { stdio: 'ignore' });
  const accounts = JSON.parse(fs.readFileSync(path.join(dir, 'accounts.json'), 'utf8'));
  const src = path.join(dir, 'events.ndjson');
  const a = await inProc(src, accounts, true);
  const b = await runSharded({ shards: 2, source: src, accounts, detail: true });
  assert.equal(JSON.stringify(b), JSON.stringify(a));
  const codes = new Set(a.flatMap((r) => Object.keys(r.errorCounts)));
  for (const c of ['INVALID_JSON', 'DUPLICATE_EVENT', 'SETTLEMENT_UNKNOWN_AUTH', 'UNKNOWN_ACCOUNT']) assert.ok(codes.has(c), c);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('routing hash is stable (a changed hash would silently re-partition accounts)', () => {
  assert.equal(fnv1a('ACC-001'), fnv1a('ACC-001'));
  assert.equal(fnv1a(''), 0x811c9dc5);
  assert.equal(fnv1a('a'), 0xe40c292c); // published FNV-1a 32-bit test vector
});

test('CLI replay exits 0 and prints the four required things per day', () => {
  const out = execFileSync(process.execPath, [path.join(DIST, 'bin', 'replay.js')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  for (let d = 1; d <= 6; d++) assert.match(out, new RegExp(`DAY ${d} CLOSE`));
  assert.match(out, /Closing ledger balance D6: 390\.92/);
  assert.match(out, /FEE:ACC-001:D2 {2}DEBIT 25\.00/);
  assert.match(out, /Auth-B \(E8\) DECLINED/);
  assert.match(out, /E6 ACC-001 SETTLEMENT_UNKNOWN_AUTH/);
});

test('CLI: unreadable input is a fatal exit 1; bad flags are exit 2', () => {
  const run = (args: string[]) => {
    try { execFileSync(process.execPath, [path.join(DIST, 'bin', 'replay.js'), ...args], { stdio: 'ignore' }); return 0; } catch (e) { return (e as { status: number }).status; }
  };
  assert.equal(run(['/nonexistent.ndjson']), 1);
  assert.equal(run(['--bogus']), 2);
  assert.equal(run(['--shards', '-1']), 2);
});
