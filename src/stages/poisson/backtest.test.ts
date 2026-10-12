import { describe, it, expect } from '@jest/globals';
import { logLossBrier, groupByDay, weightedMean } from './backtest';
import { MatchRecord } from './history';

const mk = (i: number, home: string, away: string, hg: number, ag: number) => ({
  date: `2025-01-0${i}`,
  home, away, hg, ag,
  market: { oneX2: null, ou25: null } as const,
});

const toRecord = (i: number, home: string, away: string, hg: number, ag: number): MatchRecord => ({
  league: 'X',
  date: `2025-01-0${i}`,
  home, away, hg, ag,
  hthg: hg, htag: ag,
  stats: {},
});

function expectClose(a: number, b: number) {
  expect(Math.abs(a - b)).toBeLessThan(1e-9);
}

// Helper to manually compute log loss and brier for a small case.
function manualLLB(outcomes: (number | null)[], probs: (number[] | null)[], k: number) {
  let n = 0, ll = 0, br = 0;
  for (let i = 0; i < outcomes.length; i++) {
    const o = outcomes[i], p = probs[i];
    if (o == null || p == null || p.length !== k) continue;
    ll += -Math.log(Math.max(p[o], 1e-12));
    for (let j = 0; j < k; j++) br += (p[j] - (j === o ? 1 : 0)) ** 2;
    n++;
  }
  if (!n) return null;
  return { logLoss: ll / n, brier: br / (n * k) };
}

describe('logLossBrier', () => {
  it('computes log loss and Brier for k=2', () => {
    const o = [0, 1];
    const p = [[0.9, 0.1], [0.3, 0.7]];
    const m = logLossBrier(o, p, 2)!;
    const ref = manualLLB(o, p, 2)!;
    expectClose(m.logLoss, ref.logLoss);
    expectClose(m.brier, ref.brier);
  });

  it('uniform guesses: log loss = ln(k), normalized Brier = 1/k - 1/k^2', () => {
    // Per-match unnormalized Brier for uniform 1/k is 1 - 1/k; the function additionally
    // divides by k, giving 1/k - 1/k^2 (2/9 for k = 3).
    const k = 3;
    const o = [0, 1, 2, 0, 1, 2, 0, 1, 2];
    const p = Array.from({ length: 9 }, () => [1 / k, 1 / k, 1 / k]);
    const m = logLossBrier(o, p, k);
    expectClose(m!.logLoss, Math.log(3));
    expectClose(m!.brier, 2 / 9);
  });

  it('returns null when no data is scoreable', () => {
    expect(logLossBrier([], [], 3)).toBeNull();
    expect(logLossBrier([0, 1], [null, null], 3)).toBeNull();
    expect(logLossBrier([0, 1], [[0.9, 0.05, 0.05], null], 3)).not.toBeNull();
  });

  it('skips individual entries where the outcome or probability is null', () => {
    const o = [0, null, 1, null];
    const p = [[0.7, 0.2, 0.1], null, [0.1, 0.7, 0.2], [0.5, 0.5, 0]];
    const m = logLossBrier(o, p, 3)!;
    const ref = manualLLB(o, p, 3)!;
    expectClose(m.logLoss, ref.logLoss);
    expectClose(m.brier, ref.brier);
  });
});

describe('groupByDay', () => {
  const day1 = [mk(1, 'A', 'B', 2, 0), mk(1, 'C', 'D', 3, 1), mk(1, 'B', 'A', 1, 1)];
  const day2 = [mk(2, 'A', 'C', 4, 0), mk(2, 'B', 'D', 2, 2), mk(2, 'C', 'B', 1, 3)];

  it('groups by date while preserving order', () => {
    const g = groupByDay([...day1, ...day2]);
    expect(g.length).toBe(2);
    expect(g[0][1].length).toBe(3);
    expect(g[1][1].length).toBe(3);
    expect(g[0][0]).toBe(day1[0].date);
    expect(g[1][0]).toBe(day2[0].date);
  });

  it('handles empty input', () => {
    expect(groupByDay([])).toEqual([]);
  });

  it('handles a single record', () => {
    const g = groupByDay([mk(1, 'A', 'B', 1, 1)]);
    expect(g.length).toBe(1);
    expect(g[0][1].length).toBe(1);
  });
});

describe('weightedMean', () => {
  it('equals plain mean when all weights are equal', () => {
    expect(weightedMean([[1, 3], [3, 3]])).toBeCloseTo(2, 12);
  });

  it('respects per-day weights (uneven day sizes)', () => {
    expect(weightedMean([[1.0, 2], [2.0, 1]])).toBeCloseTo((1.0 * 2 + 2.0 * 1) / 3, 12);
  });

  it('returns null on empty input', () => {
    expect(weightedMean([])).toBeNull();
  });

  it('returns null when all weights are zero', () => {
    expect(weightedMean([[1.0, 0], [2.0, 0]])).toBeNull();
  });
});
