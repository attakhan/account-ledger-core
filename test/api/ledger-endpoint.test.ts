/**
 * The HTTP API over the brief's scenario, through a real HTTP listener on an
 * ephemeral port. The events file is a temp copy, because POST writes to it.
 *
 * The tests run in order and share one store: the GET tests run first, against
 * the unmodified scenario, and the POST tests then add events to it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ACCOUNTS, SCENARIO } from '../helpers';
import type { AccountLedger } from '../../src/account-ledger';
import { LedgerStore } from '../../src/ledger-store';
import { createApp } from '../../src/server';

let server: Server;
let base: string;
let dir: string;
let eventsPath: string;

test.before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-api-'));
  eventsPath = path.join(dir, 'events.ndjson');
  fs.copyFileSync(SCENARIO, eventsPath);
  const store = new LedgerStore({ eventsPath, accounts: ACCOUNTS });
  await store.load();
  const app = createApp(store);
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(dir, { recursive: true, force: true });
});

const get = (p: string, init?: RequestInit) => fetch(base + p, init);
const post = (p: string, body: unknown) => fetch(base + p, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body),
});
const fileLines = () => fs.readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean);

test('ACC-001 ledger: parties, balances, every entry with running balance, decimals as strings', async () => {
  const res = await get('/accounts/ACC-001/ledger');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /application\/json/);
  const l = (await res.json()) as AccountLedger;

  assert.deepEqual(l.account, { accountNumber: 'ACC-001', accountName: 'ACC1 Account Name', bankName: 'ACC1 Bank Name',
    bic: 'ACC1BICX', iban: 'AE00ACC1DUMMYIBAN0000001', currency: 'AED', minorUnits: 2 });
  assert.deepEqual(l.window, { firstDay: 1, lastDay: 6, closedThroughDay: 6, windowClosed: true });
  assert.equal(l.balances.opening, '0.00');
  assert.equal(l.balances.closing, '390.92');
  assert.equal(l.balances.available, '390.92');
  assert.equal(l.balances.interestCapitalized, '0.92');

  // Running balance ends at the closing balance, and totals reconcile.
  assert.equal(l.entries.at(-1)?.balanceAfter, l.balances.closing);
  assert.equal(l.totals.entries, l.entries.length);
  assert.equal(l.totals.netMovement, '390.92');

  // Debit and credit are separate columns, never both set.
  for (const e of l.entries) assert.ok((e.debit === null) !== (e.credit === null), e.entryId);
  const e7 = l.entries.find((e) => e.entryId === 'E7')!;
  assert.deepEqual([e7.direction, e7.debit, e7.postingDate, e7.valueDate], ['DEBIT', '620.00', 5, 2]);
  assert.equal(e7.to?.accountNumber, 'EXT-E7-PAYEE');
  assert.deepEqual(l.entries.filter((e) => e.kind === 'FEE').map((e) => e.valueDate), [2, 4, 5]);

  assert.deepEqual(l.valueDayBalances.map((d) => d.closingBalance), ['250.00', '225.00', '625.00', '415.00', '390.00', '390.92']);
  assert.deepEqual(l.authorizations.map((a) => [a.authId, a.state]), [['Auth-A', 'SETTLED'], ['Auth-B', 'DECLINED']]);
  assert.deepEqual(l.rejectedEvents.map((r) => [r.eventId, r.code]), [['E6', 'SETTLEMENT_UNKNOWN_AUTH']]);
});

test('ACC-002 ledger: BHD at three decimals, instalments kept as separate entries', async () => {
  const l = (await (await get('/accounts/ACC-002/ledger')).json()) as AccountLedger;
  assert.equal(l.account.minorUnits, 3);
  assert.deepEqual(l.entries.filter((e) => e.eventId === 'E10').map((e) => e.credit), ['3.334', '3.333', '3.333']);
  assert.equal(l.balances.closing, '10.008');
});

test('unknown account is 404 UNKNOWN_ACCOUNT; account numbers are URL-decoded', async () => {
  const res = await get('/accounts/NOPE%2F1/ledger');
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: { code: 'UNKNOWN_ACCOUNT', message: 'unknown account NOPE/1' } });
});

test('other methods are 405, other paths 404, bad encoding 400', async () => {
  const wrong = await get('/accounts/ACC-001/ledger', { method: 'POST' });
  assert.equal(wrong.status, 405);
  assert.equal(wrong.headers.get('allow'), 'GET, HEAD');
  assert.equal((await get('/accounts/ACC-001/events')).status, 405);
  assert.equal((await get('/accounts/ACC-001')).status, 404);
  assert.equal((await get('/accounts/%E0%A4%A/ledger')).status, 400);
});

test('POST event without a day lands on the last day in the file, is persisted, and shows in the ledger', async () => {
  const before = fileLines().length;
  const res = await post('/accounts/ACC-001/events', { id: 'API-1', type: 'CREDIT', currency: 'AED', amount: '100.00',
    counterparty: { accountNumber: 'EXT-API', accountName: 'API Sender' } });
  assert.equal(res.status, 201);
  assert.equal(res.headers.get('location'), '/accounts/ACC-001/ledger');
  const body = await res.json() as { status: string; postingDay: number; entries: string[]; event: Record<string, unknown>; ledger: AccountLedger };
  assert.equal(body.status, 'ACCEPTED');
  assert.equal(body.postingDay, 6, 'the scenario ends on D6');
  assert.deepEqual(body.entries, ['API-1']);
  assert.equal(body.event.account, 'ACC-001');
  // D6 is still inside the window, so the event is booked before the D6 close,
  // and the interest capitalization posted at that close follows it.
  assert.deepEqual(body.ledger.entries.slice(-2).map((x) => x.entryId), ['API-1', 'INT:ACC-001:D6']);

  // Persisted: one more line in the file, exactly the event returned.
  const lines = fileLines();
  assert.equal(lines.length, before + 1);
  assert.deepEqual(JSON.parse(lines.at(-1)!), body.event);

  // Visible to GET, and to a fresh store rebuilt from the file (a restart).
  const l = await (await get('/accounts/ACC-001/ledger')).json() as AccountLedger;
  const e = l.entries.find((x) => x.entryId === 'API-1')!;
  assert.deepEqual([e.credit, e.postingDate, e.valueDate], ['100.00', 6, 6]);
  const fresh = new LedgerStore({ eventsPath, accounts: ACCOUNTS });
  await fresh.load();
  assert.deepEqual(fresh.ledger('ACC-001'), l);
});

test('POST without an id gets a generated one; the path decides the account', async () => {
  const res = await post('/accounts/ACC-002/events', { type: 'DEBIT', currency: 'BHD', amount: '1.000' });
  assert.equal(res.status, 201);
  const body = await res.json() as { event: { id: string; account: string } };
  assert.match(body.event.id, /^API-[0-9a-f-]{36}$/);
  assert.equal(body.event.account, 'ACC-002');
});

test('a rejected event is 422 with the ledger code, and nothing is written', async () => {
  const before = fs.readFileSync(eventsPath, 'utf8');
  const cases: [unknown, string][] = [
    [{ id: 'API-1', type: 'CREDIT', currency: 'AED', amount: '1.00' }, 'DUPLICATE_EVENT'],
    [{ id: 'API-2', type: 'SETTLEMENT', currency: 'AED', authId: 'Auth-Z', amount: '1.00' }, 'SETTLEMENT_UNKNOWN_AUTH'],
    [{ id: 'API-3', type: 'CREDIT', currency: 'AED', amount: '1.005' }, 'AMOUNT_PRECISION'],
    [{ id: 'API-4', day: 7, type: 'CREDIT', currency: 'AED', amount: '1.00' }, 'OUT_OF_WINDOW'],
  ];
  for (const [ev, code] of cases) {
    const res = await post('/accounts/ACC-001/events', ev);
    assert.equal(res.status, 422, code);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, code);
  }
  assert.equal(fs.readFileSync(eventsPath, 'utf8'), before);
});

test('POST input errors: bad JSON 400, account mismatch 400, unknown account 404', async () => {
  const before = fs.readFileSync(eventsPath, 'utf8');
  assert.equal((await post('/accounts/ACC-001/events', '{"id": broken')).status, 400);
  assert.equal((await post('/accounts/ACC-001/events', [1, 2])).status, 400);
  assert.equal((await post('/accounts/ACC-001/events', { account: 'ACC-002', type: 'CREDIT' })).status, 400);
  assert.equal((await post('/accounts/NOPE/events', { type: 'CREDIT', currency: 'AED', amount: '1.00' })).status, 404);
  assert.equal(fs.readFileSync(eventsPath, 'utf8'), before);
});
