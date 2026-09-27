'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { replay, inProcess } = require('../src/replay');
const { ShardedEngine } = require('../src/sharded');
const { DEFAULT_POLICY } = require('../src/config');
const { LedgerShard } = require('../src/shard');

const ROOT = path.join(__dirname, '..');
const ACCOUNTS = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'accounts.json'), 'utf8'));
const SCENARIO = path.join(ROOT, 'data', 'scenario.ndjson');
const scenarioLines = () => fs.readFileSync(SCENARIO, 'utf8').split('\n').filter(Boolean);

/** Replay the brief's scenario in-process. Returns reports by day plus the shard for deep inspection. */
async function runScenario({ policy = DEFAULT_POLICY, lines = scenarioLines(), accounts = ACCOUNTS } = {}) {
  const engine = inProcess(accounts, { policy, detail: true });
  const { reports } = await replay({ source: lines, engine, policy });
  const byDay = Object.fromEntries(reports.map((r) => [r.day, r]));
  const acct = (day, id) => byDay[day].accounts.find((a) => a.account === id);
  return { reports, byDay, acct, shard: engine.shard };
}

async function runSharded({ shards, policy = DEFAULT_POLICY, source, accounts = ACCOUNTS, detail = true }) {
  const engine = new ShardedEngine({ accounts, shards, policy, detail, errorSampleLimit: Infinity });
  try {
    const { reports } = await replay({ source, engine, policy });
    return reports;
  } finally {
    await engine.close();
  }
}

/** A fresh shard driven by hand: `ev(...)` applies, `close(d)` closes. */
function harness({ accounts = ACCOUNTS, policy = DEFAULT_POLICY } = {}) {
  const shard = new LedgerShard({ accounts, policy, detail: true });
  let seq = 0;
  return {
    shard,
    ev: (e) => shard.apply(e, ++seq),
    close: (d) => shard.closeDay(d),
    closeThrough: (d) => { const out = []; while (shard.openDay <= d) out.push(shard.closeDay(shard.openDay)); return out; },
  };
}

module.exports = { ROOT, ACCOUNTS, SCENARIO, scenarioLines, runScenario, runSharded, harness };
