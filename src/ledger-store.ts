/**
 * Persistent ledger for the HTTP API. The events NDJSON file is the only
 * durable state: the ledger is always the result of replaying that file, so
 * a restart rebuilds exactly what was served before.
 *
 * Adding an event:
 *  1. A missing `day` defaults to the last day present in the file.
 *  2. The file plus the new event is replayed in memory (a dry run).
 *  3. If the ledger rejects the event, nothing is written and the rejection
 *     is returned. The file only ever gains events the ledger accepted.
 *  4. Otherwise the line is appended and fsynced, then the new state is
 *     swapped in.
 * Writes are serialised, so two concurrent requests cannot interleave between
 * the dry run and the append.
 *
 * Cost: each add replays the whole file. That is fine at this scale; a large
 * stream would want snapshots, which the brief rules out.
 */
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { replay, inProcess } from './replay';
import { DEFAULT_POLICY, DEFAULT_RUNTIME } from './config';
import { AccountLedgerIndex, type AccountLedger } from './account-ledger';
import type { LedgerShard } from './shard';
import type { AccountConfig, EventLogRecord, JournalEntry, Policy } from './types';

export interface LedgerState {
  shard: LedgerShard;
  index: AccountLedgerIndex;
  events: number;
  /** Latest posting day among events in the file (firstDay if there are none). */
  lastEventDay: number;
}

export type AddEventResult =
  | { status: 'ACCEPTED'; event: Record<string, unknown>; log: EventLogRecord; entries: JournalEntry[]; ledger: AccountLedger }
  | { status: 'REJECTED'; event: Record<string, unknown>; log: EventLogRecord };

export class LedgerStore {
  readonly eventsPath: string;
  readonly accounts: AccountConfig[];
  readonly policy: Policy;
  private state: LedgerState | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor({ eventsPath, accounts, policy = DEFAULT_POLICY }: { eventsPath: string; accounts: AccountConfig[]; policy?: Policy }) {
    this.eventsPath = eventsPath;
    this.accounts = accounts;
    this.policy = policy;
  }

  /** Replay the file. Must be called (and awaited) before any query. */
  async load(): Promise<LedgerState> {
    this.state = await this.build(this.readLines());
    return this.state;
  }

  get current(): LedgerState {
    if (!this.state) throw new Error('LedgerStore.load() has not completed');
    return this.state;
  }

  ledger(accountNumber: string): AccountLedger | null { return this.current.index.ledger(accountNumber); }

  /** Validate, persist and apply one event for `accountNumber`. */
  addEvent(accountNumber: string, input: Record<string, unknown>): Promise<AddEventResult> {
    const run = this.queue.then(() => this.addEventNow(accountNumber, input));
    this.queue = run.catch(() => {});
    return run;
  }

  private async addEventNow(accountNumber: string, input: Record<string, unknown>): Promise<AddEventResult> {
    const state = this.current;
    const event: Record<string, unknown> = {
      id: input.id ?? `API-${randomUUID()}`,
      day: input.day ?? state.lastEventDay,
      ...input,
      account: accountNumber,
    };
    const line = JSON.stringify(event);
    const lines = this.readLines();
    lines.push(line);

    const next = await this.build(lines);
    const log = next.shard.eventLog.find((l) => l.seq === next.events);
    if (!log) throw new Error(`dry run produced no log record for seq ${next.events}`);
    if (log.status === 'REJECTED') return { status: 'REJECTED', event, log };

    await this.append(line);
    this.state = next;
    const entries = next.shard.journal.filter((e) => e.eventId === event.id && e.account === accountNumber);
    return { status: 'ACCEPTED', event, log, entries, ledger: next.index.ledger(accountNumber)! };
  }

  private readLines(): string[] {
    if (!fs.existsSync(this.eventsPath)) return [];
    return fs.readFileSync(this.eventsPath, 'utf8').split('\n').filter((l) => l.trim() !== '');
  }

  private async build(lines: string[]): Promise<LedgerState> {
    const engine = inProcess(this.accounts, { policy: this.policy, detail: false,
      errorSampleLimit: DEFAULT_RUNTIME.errorSampleLimit, retainJournal: true });
    const { events } = await replay({ source: lines, engine, policy: this.policy, keepReports: false });
    const shard = engine.shard;
    let lastEventDay = this.policy.window.firstDay;
    for (const l of shard.eventLog) {
      if (l.postingDate !== null && l.postingDate > lastEventDay && l.postingDate <= this.policy.window.lastDay) lastEventDay = l.postingDate;
    }
    return { shard, index: new AccountLedgerIndex(shard), events, lastEventDay };
  }

  /** Append one line durably, adding a separating newline if the file lacks a trailing one. */
  private async append(line: string): Promise<void> {
    const fh = await fs.promises.open(this.eventsPath, 'a+');
    try {
      const { size } = await fh.stat();
      let prefix = '';
      if (size > 0) {
        const last = Buffer.alloc(1);
        await fh.read(last, 0, 1, size - 1);
        if (last[0] !== 0x0a) prefix = '\n';
      }
      await fh.appendFile(`${prefix}${line}\n`, 'utf8');
      await fh.datasync();
    } finally {
      await fh.close();
    }
  }
}
