/**
 * ShardedEngine: partitions accounts across worker threads by a stable hash
 * of the account id. Accounts never interact (there is no atomic cross-account
 * event, see REJECTED.md), so each shard is independent. Per-account order is
 * preserved because one account always maps to the same worker, and a worker
 * processes its messages in FIFO order.
 *
 * Throughput: events are batched (batchSize) to amortise postMessage cost.
 * Backpressure: at most maxInFlightBatches unacknowledged batches per worker.
 * Past that, apply() awaits and the replayer stops pulling lines, so memory
 * stays bounded however large the input file is.
 * Day close is a barrier: flush every buffer, then ask every shard to close,
 * then merge the reports deterministically.
 * Failure: any worker error or unexpected exit fails the replay (fail-stop).
 * Nothing is retried, because a partially applied batch cannot be told apart
 * from an unapplied one without persistence.
 */
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import { mergeReports } from './merge';
import { DEFAULT_POLICY, DEFAULT_RUNTIME } from './config';
import type { AccountConfig, DayReport, Engine, Policy } from './types';
import type { LedgerShardOptions } from './shard';

/** Messages a worker sends back (see worker.ts). */
export type WorkerReply = { t: 'ack' } | { t: 'report'; report: DayReport };
/** Messages the router sends to a worker (see worker.ts). */
export type WorkerCommand =
  | { t: 'b'; items: unknown[] }
  | { t: 'r'; seq: number; code: string; msg: string }
  | { t: 'c'; day: number };

interface Deferred<T> { resolve: (v: T) => void; reject: (e: Error) => void }

interface ShardHandle {
  i: number;
  worker: Worker;
  buf: unknown[];
  inFlight: number;
  waiters: Deferred<void>[];
  pendingClose: Deferred<DayReport> | null;
}

export interface ShardedEngineOptions {
  accounts: AccountConfig[];
  shards: number;
  policy?: Policy;
  detail?: boolean;
  errorSampleLimit?: number;
  retainJournal?: boolean;
  batchSize?: number;
  maxInFlightBatches?: number;
}

/** FNV-1a 32-bit: stable across runs and processes (unlike Map iteration or a random seed). */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export class ShardedEngine implements Engine {
  readonly n: number;
  readonly batchSize: number;
  readonly maxInFlight: number;
  failed: Error | null;
  closing: boolean;
  readonly workers: ShardHandle[];

  constructor({ accounts, shards, policy = DEFAULT_POLICY, detail = false, errorSampleLimit = DEFAULT_RUNTIME.errorSampleLimit,
    retainJournal = true, batchSize = DEFAULT_RUNTIME.batchSize, maxInFlightBatches = DEFAULT_RUNTIME.maxInFlightBatches }: ShardedEngineOptions) {
    if (!Number.isSafeInteger(shards) || shards < 1) throw new RangeError('shards must be a positive integer');
    this.n = shards;
    this.batchSize = batchSize;
    this.maxInFlight = maxInFlightBatches;
    this.failed = null;
    this.closing = false;
    const parts: AccountConfig[][] = Array.from({ length: shards }, () => []);
    for (const a of accounts) parts[this.shardOf(a.id)].push(a);
    this.workers = parts.map((accts, i) => {
      const workerData: LedgerShardOptions = { accounts: accts, policy, detail, errorSampleLimit, retainJournal };
      const worker = new Worker(path.join(__dirname, 'worker.js'), { workerData });
      const w: ShardHandle = { i, worker, buf: [], inFlight: 0, waiters: [], pendingClose: null };
      worker.on('message', (m: WorkerReply) => this._onMessage(w, m));
      worker.on('error', (e: Error) => this._fail(new Error(`shard ${i} crashed: ${e && e.stack ? e.stack : e}`)));
      worker.on('exit', (code: number) => { if (!this.closing) this._fail(new Error(`shard ${i} exited unexpectedly (code ${code})`)); });
      return w;
    });
  }

  shardOf(accountId: string): number { return fnv1a(accountId) % this.n; }

  _onMessage(w: ShardHandle, m: WorkerReply): void {
    if (m.t === 'ack') {
      w.inFlight--;
      const next = w.waiters.shift();
      if (next) next.resolve();
    } else if (m.t === 'report') {
      const p = w.pendingClose;
      w.pendingClose = null;
      if (p) p.resolve(m.report);
    }
  }

  _fail(err: Error): void {
    if (this.failed) return;
    this.failed = err;
    for (const w of this.workers) {
      for (const x of w.waiters.splice(0)) x.reject(err);
      if (w.pendingClose) { w.pendingClose.reject(err); w.pendingClose = null; }
    }
  }

  _check(): void { if (this.failed) throw this.failed; }

  _post(w: ShardHandle, m: WorkerCommand): void { w.worker.postMessage(m); }

  async _flush(w: ShardHandle): Promise<void> {
    if (w.buf.length === 0) return;
    while (w.inFlight >= this.maxInFlight) {
      await new Promise<void>((resolve, reject) => w.waiters.push({ resolve, reject }));
    }
    this._check();
    const items = w.buf;
    w.buf = [];
    w.inFlight++;
    this._post(w, { t: 'b', items });
  }

  /** Returns undefined on the fast path, or a promise when a batch had to be flushed (backpressure). */
  apply(raw: unknown, seq: number, line: string | null = null): Promise<void> | undefined {
    this._check();
    const r = raw as { account?: unknown } | null;
    const acct = r && typeof r.account === 'string' ? r.account : '';
    const w = this.workers[this.shardOf(acct)];
    // Ship the original text when we have it (the worker re-parses): cloning a
    // string is a memcpy, cloning an object graph is a walk. Measured in WORKLOG.
    w.buf.push(seq, line !== null ? line : raw);
    if (w.buf.length >= this.batchSize * 2) return this._flush(w);
    return undefined;
  }

  async rejectRaw(seq: number, code: string, msg: string): Promise<void> {
    this._check();
    const w = this.workers[0];
    await this._flush(w);
    this._post(w, { t: 'r', seq, code, msg });
  }

  async closeDay(day: number): Promise<DayReport> {
    this._check();
    await Promise.all(this.workers.map((w) => this._flush(w)));
    const reports = await Promise.all(this.workers.map((w) => new Promise<DayReport>((resolve, reject) => {
      w.pendingClose = { resolve, reject };
      this._post(w, { t: 'c', day });
    })));
    this._check();
    return mergeReports(reports);
  }

  async close(): Promise<void> {
    this.closing = true;
    await Promise.all(this.workers.map((w) => w.worker.terminate()));
  }
}
