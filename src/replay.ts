/**
 * Replayer: drives an engine (one in-process shard, or a pool of worker
 * shards) through an ordered stream of NDJSON lines.
 *
 * Day handling: an event whose `day` is later than the open day first closes
 * every day in between (end-of-day batch), then gets applied. An event whose
 * `day` is earlier than the open day is a late arrival. Its postingDate is
 * kept, it is processed in the open day, and its value date drives
 * restatement of the earlier days at the next close. At end of stream, every
 * remaining day through the last day of the window is closed.
 */
import * as fs from 'node:fs';
import { LedgerShard } from './shard';
import { CODES } from './errors';
import { DEFAULT_POLICY, DEFAULT_RUNTIME } from './config';
import { mergeReports } from './merge';
import type { AccountConfig, DayReport, Engine, Policy } from './types';

export interface InProcessOptions {
  accounts: AccountConfig[];
  policy: Policy;
  detail: boolean;
  errorSampleLimit: number;
  retainJournal?: boolean;
}

export class InProcessEngine implements Engine {
  readonly shard: LedgerShard;
  constructor({ accounts, policy, detail, errorSampleLimit, retainJournal = true }: InProcessOptions) {
    this.shard = new LedgerShard({ accounts, policy, detail, errorSampleLimit, retainJournal });
  }
  apply(raw: unknown, seq: number): void { this.shard.apply(raw, seq); }
  rejectRaw(seq: number, code: string, message: string): void { this.shard.rejectRaw(seq, code, message); }
  async closeDay(day: number): Promise<DayReport> { return mergeReports([this.shard.closeDay(day)]); }
  async close(): Promise<void> {}
}

/** A file path, a readable stream of text, or an in-memory array of lines/objects. */
export type ReplaySource = string | AsyncIterable<string | Buffer> | unknown[];

/**
 * Async iterable of line BATCHES from a file path, a readable stream, or an
 * array of strings/objects. Yielding one array per 64 KiB chunk rather than
 * one promise per line removes a microtask per event (see WORKLOG 17:5x).
 * Backpressure is natural: the next chunk is not read until the consumer
 * finishes the current batch.
 */
export async function* lineBatches(source: ReplaySource): AsyncGenerator<unknown[]> {
  if (Array.isArray(source)) { yield source; return; }
  const input = typeof source === 'string' ? fs.createReadStream(source, { encoding: 'utf8', highWaterMark: 1 << 16 }) : source;
  let tail = '';
  for await (const chunk of input) {
    const text = tail + chunk;
    const parts = text.split('\n');
    tail = parts.pop()!;
    if (parts.length) yield parts;
  }
  if (tail.length) yield [tail];
}

/** Line-at-a-time view kept for callers that want it. */
export async function* lines(source: ReplaySource): AsyncGenerator<unknown> {
  for await (const batch of lineBatches(source)) yield* batch;
}

export interface ReplayOptions {
  source: ReplaySource;
  engine: Engine;
  policy?: Policy;
  onDayClosed?: (report: DayReport) => void | Promise<void>;
  keepReports?: boolean;
}

export async function replay({ source, engine, policy = DEFAULT_POLICY, onDayClosed, keepReports = true }: ReplayOptions):
  Promise<{ reports: DayReport[]; events: number }> {
  const { firstDay, lastDay } = policy.window;
  let openDay = firstDay;
  let seq = 0;
  const reports: DayReport[] = [];

  const closeThrough = async (lastToClose: number): Promise<void> => {
    while (openDay <= lastToClose) {
      const r = await engine.closeDay(openDay);
      if (keepReports) reports.push(r);
      if (onDayClosed) await onDayClosed(r);
      openDay++;
    }
  };

  for await (const batch of lineBatches(source)) {
   for (let li = 0; li < batch.length; li++) {
    const item = batch[li];
    const line = typeof item === 'string' && item.endsWith('\r') ? item.slice(0, -1) : item;
    let raw: unknown = line;
    if (typeof line === 'string') {
      if (line.trim() === '') continue;
      seq++;
      try {
        raw = JSON.parse(line);
      } catch (e) {
        await engine.rejectRaw(seq, CODES.INVALID_JSON, `line ${seq}: ${(e as Error).message}`);
        continue;
      }
    } else {
      seq++;
    }
    const day = raw && (raw as { day?: unknown }).day;
    // Only a valid, in-window future day advances the clock. Anything else is
    // left for the shard to reject (OUT_OF_WINDOW / INVALID_EVENT) without
    // closing days early.
    if (Number.isSafeInteger(day) && (day as number) > openDay && (day as number) <= lastDay) await closeThrough((day as number) - 1);
    // Engines that cross a thread boundary take the original line too: a
    // string is far cheaper to structured-clone than the parsed object graph.
    const pending = engine.apply(raw, seq, typeof line === 'string' ? line : null); // sync unless backpressure
    if (pending) await pending;
   }
  }
  await closeThrough(lastDay);
  return { reports, events: seq };
}

export function inProcess(accounts: AccountConfig[],
  opts: { policy?: Policy; detail?: boolean; errorSampleLimit?: number; retainJournal?: boolean } = {}): InProcessEngine {
  const policy = opts.policy || DEFAULT_POLICY;
  const detail = opts.detail ?? accounts.length <= DEFAULT_RUNTIME.detailAccountLimit;
  return new InProcessEngine({ accounts, policy, detail, errorSampleLimit: opts.errorSampleLimit ?? Infinity,
    retainJournal: opts.retainJournal ?? true });
}
