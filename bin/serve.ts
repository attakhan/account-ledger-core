#!/usr/bin/env node
/**
 * Replay an NDJSON event stream in-process, then serve the resulting ledger
 * over HTTP (Express):
 *
 *   node dist/bin/serve.js [events.ndjson] [--accounts data/accounts.json] [--seed data/scenario.ndjson]
 *        [--port 3000] [--host 127.0.0.1] [--vat-bps N]
 *
 *   GET  /accounts/{accountNumber}/ledger   the account's full ledger as JSON
 *   POST /accounts/{accountNumber}/events   add one event; accepted events are
 *                                           appended to the events file (persistent)
 *
 * The events file is the durable state: restarting replays it. It defaults
 * to data/events.ndjson, created on first start as a copy of the seed (the
 * brief's scenario), so the pinned scenario file itself is never modified. The replay
 * runs in-process (one shard) because the endpoints read the journal
 * directly; worker shards keep their journals inside the workers.
 *
 * Exit codes: 1 fatal (unreadable input, replay failure, cannot bind), 2 bad usage.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_POLICY, DEFAULT_RUNTIME } from '../src/config';
import { DATA_DIR } from '../src/paths';
import { LedgerStore } from '../src/ledger-store';
import { createApp } from '../src/server';
import type { AccountConfig, Policy } from '../src/types';

interface Args { events: string; accounts: string; seed: string; port: number; host: string; vatBps: number | null }

function usage(msg?: string): never {
  if (msg) process.stderr.write(`error: ${msg}\n`);
  process.stderr.write('usage: serve.js [events.ndjson] [--accounts file] [--seed file] [--port N] [--host H] [--vat-bps N]\n');
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  let events: string | null = null;
  let accounts: string | null = null;
  let seed: string | null = null;
  let port = Number(process.env.PORT ?? DEFAULT_RUNTIME.httpPort);
  let host = process.env.HOST ?? '127.0.0.1';
  let vatBps: number | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => { if (i + 1 >= argv.length) usage(`${a} needs a value`); return argv[++i]; };
    if (a === '--accounts') accounts = next();
    else if (a === '--seed') seed = next();
    else if (a === '--port') port = Number(next());
    else if (a === '--host') host = next();
    else if (a === '--vat-bps') { vatBps = Number(next()); if (!Number.isSafeInteger(vatBps) || vatBps < 0) usage('--vat-bps must be a non-negative integer'); }
    else if (a === '-h' || a === '--help') usage();
    else if (a.startsWith('--')) usage(`unknown flag ${a}`);
    else if (events === null) events = a;
    else usage(`unexpected argument ${a}`);
  }
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) usage('--port must be 0..65535');
  return {
    events: events ?? path.join(DATA_DIR, 'events.ndjson'),
    accounts: accounts ?? path.join(DATA_DIR, 'accounts.json'),
    seed: seed ?? path.join(DATA_DIR, 'scenario.ndjson'),
    port, host, vatBps,
  };
}

async function main(): Promise<void> {
  const o = parseArgs(process.argv.slice(2));
  let accounts: AccountConfig[] = [];
  try {
    accounts = JSON.parse(fs.readFileSync(o.accounts, 'utf8'));
    if (!Array.isArray(accounts)) throw new Error('accounts file must be a JSON array');
  } catch (e) { process.stderr.write(`fatal: cannot load accounts ${o.accounts}: ${(e as Error).message}\n`); process.exit(1); }
  if (!fs.existsSync(o.events)) {
    if (!fs.existsSync(o.seed)) { process.stderr.write(`fatal: neither events file ${o.events} nor seed ${o.seed} exists\n`); process.exit(1); }
    fs.copyFileSync(o.seed, o.events);
    process.stderr.write(`created ${o.events} from ${o.seed}\n`);
  }

  const policy: Policy = o.vatBps === null ? DEFAULT_POLICY
    : Object.freeze({ ...DEFAULT_POLICY, vatBps: Object.freeze({ AED: o.vatBps, BHD: o.vatBps }) });
  const store = new LedgerStore({ eventsPath: o.events, accounts, policy });
  let events: number;
  try {
    ({ events } = await store.load());
  } catch (e) {
    process.stderr.write(`fatal: replay aborted: ${e instanceof Error && e.stack ? e.stack : e}\n`);
    process.exit(1);
  }

  const app = createApp(store);
  const server = app.listen(o.port, o.host, () => {
    const addr = server.address();
    const port = addr && typeof addr === 'object' ? addr.port : o.port;
    process.stderr.write(`replayed ${events} events for ${accounts.length} accounts; listening on http://${o.host}:${port}\n`
      + `  try: curl http://${o.host}:${port}/accounts/${encodeURIComponent(accounts[0]?.id ?? 'ACC-001')}/ledger\n`);
  });
  server.on('error', (e) => { process.stderr.write(`fatal: ${e.message}\n`); process.exit(1); });
  const stop = (): void => { server.close(() => process.exit(0)); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main();
