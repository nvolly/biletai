import * as fs from 'fs';
import * as path from 'path';
import { AsyncLocalStorage } from 'async_hooks';
import { paths, settings } from '../config/config';

/**
 * What each generation, question and request really costs. Every DeepSeek and Jev call adds
 * its token counts to the meter of the work it belongs to (AsyncLocalStorage follows the
 * parallel AI workers), and the server appends one line per unit of work to
 * data/costs.jsonl. Server-side only: customers never see it.
 */
export interface Usage {
  deepseekCalls: number;
  deepseekIn: number;        // input tokens billed at the cache-miss rate
  deepseekCachedIn: number;  // input tokens served from DeepSeek's prompt cache
  deepseekOut: number;
  webSearches: number;
  jevCalls: number;
  jevIn: number;
}

export const newUsage = (): Usage => ({ deepseekCalls: 0, deepseekIn: 0, deepseekCachedIn: 0, deepseekOut: 0, webSearches: 0, jevCalls: 0, jevIn: 0 });
const als = new AsyncLocalStorage<Usage>();

/** Run `fn` with `usage` as its meter. The caller keeps `usage`, so a failed run is still counted. */
export function withUsage<T>(usage: Usage, fn: () => Promise<T>): Promise<T> {
  return als.run(usage, fn);
}

/** Add to the current meter (no-op outside `metered`, e.g. in tests or the CLI). */
export function record(part: Partial<Usage>): void {
  const u = als.getStore();
  if (!u) return;
  for (const [k, v] of Object.entries(part) as [keyof Usage, number][]) u[k] += v || 0;
}

/** USD at the configured prices (peak DeepSeek rates by default, so it errs high). */
export function usd(u: Usage): number {
  const c = settings.costs;
  return (u.deepseekIn * c.deepseekInputPerM + u.deepseekCachedIn * c.deepseekCachedInputPerM + u.deepseekOut * c.deepseekOutputPerM +
    u.jevIn * c.jevInputPerM) / 1e6 + u.webSearches * c.webSearchEach;
}

export type CostKind = 'generation' | 'ask' | 'parse';
export interface CostEntry { at: string; kind: CostKind; userId: string; ref?: string; matches?: number; usage: Usage; usd: number }

const FILE = () => path.join(paths.data, 'costs.jsonl');

export function logCost(kind: CostKind, userId: string, usage: Usage, extra: { ref?: string; matches?: number } = {}): CostEntry {
  const entry: CostEntry = { at: new Date().toISOString(), kind, userId, ...extra, usage, usd: usd(usage) };
  fs.appendFileSync(FILE(), JSON.stringify(entry) + '\n');
  return entry;
}

export function readCosts(): CostEntry[] {
  if (!fs.existsSync(FILE())) return [];
  return fs.readFileSync(FILE(), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
