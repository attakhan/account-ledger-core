'use strict';
/**
 * Shard worker: owns one LedgerShard. Messages are processed strictly in
 * arrival order, so per-account event order equals router order.
 *   {t:'b', items:[seq, raw, seq, raw, ...]}  apply a batch → {t:'ack'}
 *   {t:'r', seq, code, msg}                   record a pre-shard rejection
 *   {t:'c', day}                              close day → {t:'report', report}
 * An exception that escapes (an InvariantError or INTERNAL_ERROR) crashes the
 * worker on purpose, and the router fails the whole replay (fail-stop).
 */
const { parentPort, workerData } = require('node:worker_threads');
const { LedgerShard } = require('./shard');

const shard = new LedgerShard(workerData);

parentPort.on('message', (m) => {
  switch (m.t) {
    case 'b': {
      const it = m.items;
      for (let i = 0; i < it.length; i += 2) {
        const x = it[i + 1];
        // The router already proved the line parses, so a parse here cannot fail.
        shard.apply(typeof x === 'string' ? JSON.parse(x) : x, it[i]);
      }
      parentPort.postMessage({ t: 'ack' });
      break;
    }
    case 'r':
      shard.rejectRaw(m.seq, m.code, m.msg);
      break;
    case 'c':
      parentPort.postMessage({ t: 'report', report: shard.closeDay(m.day) });
      break;
    default:
      throw new Error(`unknown message ${m.t}`);
  }
});
