import * as fs from 'node:fs';
import * as path from 'node:path';
import { replay, inProcess, type ReplaySource } from '../src/replay';
import { ShardedEngine } from '../src/sharded';
import { DEFAULT_POLICY } from '../src/config';
import { LedgerShard } from '../src/shard';
import { DATA_DIR, DIST_ROOT, REPO_ROOT } from '../src/paths';
import type { AccountConfig, AccountDayReport, ApplyResult, DayReport, Policy } from '../src/types';

/** Repository root (data/, scripts' output). Compiled code lives under DIST. */
export const ROOT = REPO_ROOT;
export const DIST = DIST_ROOT;
export const ACCOUNTS: AccountConfig[] = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'accounts.json'), 'utf8'));
export const SCENARIO = path.join(DATA_DIR, 'scenario.ndjson');
export const scenarioLines = (): string[] => fs.readFileSync(SCENARIO, 'utf8').split('\n').filter(Boolean);

/** Replay the brief's scenario in-process. Returns reports by day plus the shard for deep inspection. */
export interface Scenario {
  reports: DayReport[];
  byDay: Record<string, DayReport>;
  acct: (day: number, id: string) => AccountDayReport;
  shard: LedgerShard;
}

export async function runScenario({ policy = DEFAULT_POLICY, lines = scenarioLines(), accounts = ACCOUNTS }:
  { policy?: Policy; lines?: string[]; accounts?: AccountConfig[] } = {}): Promise<Scenario> {
  const engine = inProcess(accounts, { policy, detail: true });
  const { reports } = await replay({ source: lines, engine, policy });
  const byDay: Record<string, DayReport> = Object.fromEntries(reports.map((r) => [r.day, r]));
  const acct = (day: number, id: string): AccountDayReport => {
    const a = byDay[day].accounts?.find((x) => x.account === id);
    if (!a) throw new Error(`no report for ${id} on D${day}`);
    return a;
  };
  return { reports, byDay, acct, shard: engine.shard };
}

export async function runSharded({ shards, policy = DEFAULT_POLICY, source, accounts = ACCOUNTS, detail = true }:
  { shards: number; policy?: Policy; source: ReplaySource; accounts?: AccountConfig[]; detail?: boolean }): Promise<DayReport[]> {
  const engine = new ShardedEngine({ accounts, shards, policy, detail, errorSampleLimit: Infinity });
  try {
    const { reports } = await replay({ source, engine, policy });
    return reports;
  } finally {
    await engine.close();
  }
}

/** A fresh shard driven by hand: `ev(...)` applies, `close(d)` closes. */
export function harness({ accounts = ACCOUNTS, policy = DEFAULT_POLICY }: { accounts?: AccountConfig[]; policy?: Policy } = {}) {
  const shard = new LedgerShard({ accounts, policy, detail: true });
  let seq = 0;
  return {
    shard,
    ev: (e: unknown): ApplyResult => shard.apply(e, ++seq),
    close: (d: number): DayReport => shard.closeDay(d),
    closeThrough: (d: number): DayReport[] => { const out: DayReport[] = []; while (shard.openDay <= d) out.push(shard.closeDay(shard.openDay)); return out; },
  };
}

