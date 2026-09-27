'use strict';
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
const fs = require('node:fs');
const readline = require('node:readline');
const { LedgerShard } = require('./shard');
const { CODES } = require('./errors');
const { DEFAULT_POLICY, DEFAULT_RUNTIME } = require('./config');
const { mergeReports } = require('./merge');

class InProcessEngine {
  constructor({ accounts, policy, detail, errorSampleLimit, retainJournal = true }) {
    this.shard = new LedgerShard({ accounts, policy, detail, errorSampleLimit, retainJournal });
  }
  apply(raw, seq) { this.shard.apply(raw, seq); }
  rejectRaw(seq, code, message) { this.shard.rejectRaw(seq, code, message); }
  async closeDay(day) { return mergeReports([this.shard.closeDay(day)]); }
  async close() {}
}

/** Async iterable of lines from a file path, a stream, or an array of strings/objects. */
async function* lines(source) {
  if (Array.isArray(source)) { yield* source; return; }
  const input = typeof source === 'string' ? fs.createReadStream(source, { encoding: 'utf8', highWaterMark: 1 << 16 }) : source;
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) yield line;
}

/**
 * @param {object} o
 * @param {AsyncIterable|Iterable|string} o.source  file path, stream or array of lines/objects
 * @param {object} o.engine  InProcessEngine | ShardedEngine
 * @param {object} [o.policy]
 * @param {(report) => void|Promise<void>} [o.onDayClosed]
 * @returns {Promise<{reports: object[], events: number}>}
 */
async function replay({ source, engine, policy = DEFAULT_POLICY, onDayClosed, keepReports = true }) {
  const { firstDay, lastDay } = policy.window;
  let openDay = firstDay;
  let seq = 0;
  const reports = [];

  const closeThrough = async (lastToClose) => {
    while (openDay <= lastToClose) {
      const r = await engine.closeDay(openDay);
      if (keepReports) reports.push(r);
      if (onDayClosed) await onDayClosed(r);
      openDay++;
    }
  };

  for await (const line of lines(source)) {
    let raw = line;
    if (typeof line === 'string') {
      if (line.trim() === '') continue;
      seq++;
      try {
        raw = JSON.parse(line);
      } catch (e) {
        engine.rejectRaw(seq, CODES.INVALID_JSON, `line ${seq}: ${e.message}`);
        continue;
      }
    } else {
      seq++;
    }
    const day = raw && raw.day;
    // Only a valid, in-window future day advances the clock. Anything else is
    // left for the shard to reject (OUT_OF_WINDOW / INVALID_EVENT) without
    // closing days early.
    if (Number.isSafeInteger(day) && day > openDay && day <= lastDay) await closeThrough(day - 1);
    await engine.apply(raw, seq);
  }
  await closeThrough(lastDay);
  return { reports, events: seq };
}

function inProcess(accounts, opts = {}) {
  const policy = opts.policy || DEFAULT_POLICY;
  const detail = opts.detail ?? accounts.length <= DEFAULT_RUNTIME.detailAccountLimit;
  return new InProcessEngine({ accounts, policy, detail, errorSampleLimit: opts.errorSampleLimit ?? Infinity,
    retainJournal: opts.retainJournal ?? true });
}

module.exports = { replay, lines, inProcess, InProcessEngine };
