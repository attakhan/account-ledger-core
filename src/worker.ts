/**
 * Shard worker: owns one LedgerShard. Messages are processed strictly in
 * arrival order, so per-account event order equals router order.
 *   {t:'b', items:[seq, raw, seq, raw, ...]}  apply a batch → {t:'ack'}
 *   {t:'r', seq, code, msg}                   record a pre-shard rejection
 *   {t:'c', day}                              close day → {t:'report', report}
 * An exception that escapes (an InvariantError or INTERNAL_ERROR) crashes the
 * worker on purpose, and the router fails the whole replay (fail-stop).
 */
import { parentPort, workerData } from 'node:worker_threads';
import { LedgerShard, type LedgerShardOptions } from './shard';
import type { WorkerCommand, WorkerReply } from './sharded';

if (!parentPort) throw new Error('worker.ts must run as a worker thread');
const port = parentPort;
const shard = new LedgerShard(workerData as LedgerShardOptions);
const reply = (m: WorkerReply): void => port.postMessage(m);

port.on('message', (m: WorkerCommand) => {
  switch (m.t) {
    case 'b': {
      const it = m.items;
      for (let i = 0; i < it.length; i += 2) {
        const x = it[i + 1];
        // The router already proved the line parses, so a parse here cannot fail.
        shard.apply(typeof x === 'string' ? JSON.parse(x) : x, it[i] as number);
      }
      reply({ t: 'ack' });
      break;
    }
    case 'r':
      shard.rejectRaw(m.seq, m.code, m.msg);
      break;
    case 'c':
      reply({ t: 'report', report: shard.closeDay(m.day) });
      break;
    default:
      throw new Error(`unknown message ${(m as { t: unknown }).t}`);
  }
});
