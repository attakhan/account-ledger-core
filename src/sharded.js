'use strict';
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
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { mergeReports } = require('./merge');
const { DEFAULT_POLICY, DEFAULT_RUNTIME } = require('./config');

/** FNV-1a 32-bit: stable across runs and processes (unlike Map iteration or a random seed). */
function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

class ShardedEngine {
  constructor({ accounts, shards, policy = DEFAULT_POLICY, detail = false, errorSampleLimit = DEFAULT_RUNTIME.errorSampleLimit,
    retainJournal = true, batchSize = DEFAULT_RUNTIME.batchSize, maxInFlightBatches = DEFAULT_RUNTIME.maxInFlightBatches }) {
    if (!Number.isSafeInteger(shards) || shards < 1) throw new RangeError('shards must be a positive integer');
    this.n = shards;
    this.batchSize = batchSize;
    this.maxInFlight = maxInFlightBatches;
    this.failed = null;
    this.closing = false;
    const parts = Array.from({ length: shards }, () => []);
    for (const a of accounts) parts[this.shardOf(a.id)].push(a);
    this.workers = parts.map((accts, i) => {
      const worker = new Worker(path.join(__dirname, 'worker.js'), {
        workerData: { accounts: accts, policy, detail, errorSampleLimit, retainJournal },
      });
      const w = { i, worker, buf: [], inFlight: 0, waiters: [], pendingClose: null };
      worker.on('message', (m) => this._onMessage(w, m));
      worker.on('error', (e) => this._fail(new Error(`shard ${i} crashed: ${e && e.stack ? e.stack : e}`)));
      worker.on('exit', (code) => { if (!this.closing) this._fail(new Error(`shard ${i} exited unexpectedly (code ${code})`)); });
      return w;
    });
  }

  shardOf(accountId) { return fnv1a(accountId) % this.n; }

  _onMessage(w, m) {
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

  _fail(err) {
    if (this.failed) return;
    this.failed = err;
    for (const w of this.workers) {
      for (const x of w.waiters.splice(0)) x.reject(err);
      if (w.pendingClose) { w.pendingClose.reject(err); w.pendingClose = null; }
    }
  }

  _check() { if (this.failed) throw this.failed; }

  async _flush(w) {
    if (w.buf.length === 0) return;
    while (w.inFlight >= this.maxInFlight) {
      await new Promise((resolve, reject) => w.waiters.push({ resolve, reject }));
    }
    this._check();
    const items = w.buf;
    w.buf = [];
    w.inFlight++;
    w.worker.postMessage({ t: 'b', items });
  }

  /** Returns undefined on the fast path, or a promise when a batch had to be flushed (backpressure). */
  apply(raw, seq, line = null) {
    this._check();
    const acct = raw && typeof raw.account === 'string' ? raw.account : '';
    const w = this.workers[this.shardOf(acct)];
    // Ship the original text when we have it (the worker re-parses): cloning a
    // string is a memcpy, cloning an object graph is a walk. Measured in WORKLOG.
    w.buf.push(seq, line !== null ? line : raw);
    if (w.buf.length >= this.batchSize * 2) return this._flush(w);
    return undefined;
  }

  async rejectRaw(seq, code, msg) {
    this._check();
    const w = this.workers[0];
    await this._flush(w);
    w.worker.postMessage({ t: 'r', seq, code, msg });
  }

  async closeDay(day) {
    this._check();
    await Promise.all(this.workers.map((w) => this._flush(w)));
    const reports = await Promise.all(this.workers.map((w) => new Promise((resolve, reject) => {
      w.pendingClose = { resolve, reject };
      w.worker.postMessage({ t: 'c', day });
    })));
    this._check();
    return mergeReports(reports);
  }

  async close() {
    this.closing = true;
    await Promise.all(this.workers.map((w) => w.worker.terminate()));
  }
}

module.exports = { ShardedEngine, fnv1a };
