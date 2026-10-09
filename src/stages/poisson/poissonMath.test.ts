import { describe, it, expect } from '@jest/globals';
import { scoreMatrix, tau, fitGoalsModel } from './dixonColes';
import { probWhere, jointProb, pred, marketsFromMatrix } from './markets';
import { poissonPmf, negBinPmf, countTable, normInv, normCdf } from './distributions';
import { slipEdge, passesEdge, fairProbs } from './edge';
import { fitCountModel, expectedCounts } from './countModel';
import { MatchRecord } from './history';

const sum = (m: number[][]) => m.flat().reduce((a, b) => a + b, 0);

describe('score matrix', () => {
  it('sums to 1 with and without the Dixon-Coles correction', () => {
    for (const [lh, la, rho] of [[1.5, 1.1, 0], [2.4, 0.6, -0.1], [0.8, 0.9, 0.05]]) {
      expect(sum(scoreMatrix(lh, la, rho))).toBeCloseTo(1, 10);
    }
  });

  it('equals independent Poissons when rho = 0', () => {
    const m = scoreMatrix(1.4, 1.2, 0);
    expect(m[2][1]).toBeCloseTo(poissonPmf(1.4, 2) * poissonPmf(1.2, 1), 6);
  });

  it('raises 0-0 and 1-1 and lowers 1-0 / 0-1 when rho < 0', () => {
    const base = scoreMatrix(1.3, 1.1, 0), dc = scoreMatrix(1.3, 1.1, -0.1);
    expect(dc[0][0]).toBeGreaterThan(base[0][0]);
    expect(dc[1][1]).toBeGreaterThan(base[1][1]);
    expect(dc[1][0]).toBeLessThan(base[1][0]);
    expect(dc[0][1]).toBeLessThan(base[0][1]);
  });

  it('tau leaves scores above 1-1 untouched', () => {
    expect(tau(2, 0, 1.5, 1, -0.1)).toBe(1);
    expect(tau(3, 3, 1.5, 1, -0.1)).toBe(1);
  });
});

describe('markets from the matrix', () => {
  const m = scoreMatrix(1.6, 1.0, -0.08);
  const mk = marketsFromMatrix(m);

  it('1X2 sums to 1, double chances are the right pairs', () => {
    expect(mk.home + mk.draw + mk.away).toBeCloseTo(1, 10);
    expect(mk.dc1X).toBeCloseTo(mk.home + mk.draw, 10);
    expect(mk.dcX2).toBeCloseTo(mk.draw + mk.away, 10);
    expect(mk.dc12).toBeCloseTo(mk.home + mk.away, 10);
  });

  it('over/under on a half line are complements', () => {
    for (const line of [0.5, 1.5, 2.5, 3.5, 4.5]) {
      expect(probWhere(m, pred.over(line)) + probWhere(m, pred.under(line))).toBeCloseTo(1, 10);
    }
  });

  it('over lines decrease as the line rises', () => {
    expect(mk.over['0.5']).toBeGreaterThan(mk.over['1.5']);
    expect(mk.over['2.5']).toBeGreaterThan(mk.over['3.5']);
  });

  it('correct scores sum to 1', () => {
    let s = 0;
    for (let h = 0; h <= 10; h++) for (let a = 0; a <= 10; a++) s += probWhere(m, pred.score(h, a));
    expect(s).toBeCloseTo(1, 10);
  });
});

describe('joint probability', () => {
  const m = scoreMatrix(1.7, 0.9, -0.05);

  it('is never above the least likely leg', () => {
    const legs = [pred.home(), pred.over(2.5), pred.btts()];
    const j = jointProb(m, legs);
    for (const leg of legs) expect(j).toBeLessThanOrEqual(probWhere(m, leg) + 1e-12);
  });

  it('is NOT the product of correlated legs', () => {
    // Home win and over 1.5 are positively correlated (a home win needs goals).
    const pH = probWhere(m, pred.home()), pO = probWhere(m, pred.over(1.5));
    const j = jointProb(m, [pred.home(), pred.over(1.5)]);
    expect(j).toBeGreaterThan(pH * pO);
  });

  it('is exactly zero for contradictory legs', () => {
    expect(jointProb(m, [pred.home(), pred.away()])).toBe(0);
    expect(jointProb(m, [pred.under(0.5), pred.btts()])).toBe(0);
  });

  it('matches a hand-computed cell sum', () => {
    // "Home win & under 2.5" = 1-0, 2-0
    const expected = m[1][0] + m[2][0];
    expect(jointProb(m, [pred.home(), pred.under(2.5)])).toBeCloseTo(expected, 12);
  });
});

describe('count distributions', () => {
  it('negative binomial collapses to Poisson at dispersion 1', () => {
    expect(negBinPmf(4.5, 1, 3)).toBeCloseTo(poissonPmf(4.5, 3), 12);
  });

  it('negative binomial keeps the mean and inflates the variance', () => {
    const t = countTable(4.5, 1.6, 60);
    const mean = Array.from(t).reduce((s, p, k) => s + p * k, 0);
    const v = Array.from(t).reduce((s, p, k) => s + p * (k - mean) ** 2, 0);
    expect(Array.from(t).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 8);
    expect(mean).toBeCloseTo(4.5, 3);
    expect(v / mean).toBeCloseTo(1.6, 2);
  });

  it('normInv inverts normCdf', () => {
    for (const p of [0.01, 0.2, 0.5, 0.8, 0.99]) expect(normCdf(normInv(p))).toBeCloseTo(p, 5);
  });
});

describe('edge', () => {
  it('is joint probability times combined odds minus one', () => {
    expect(slipEdge(0.7, 1.6)).toBeCloseTo(0.12, 10);
    expect(slipEdge(0.5, 1.9)).toBeCloseTo(-0.05, 10);
  });

  it('applies the threshold inclusively', () => {
    expect(passesEdge(0.7, 1.5, 0.05)).toBe(true);   // +5.0%
    expect(passesEdge(0.7, 1.49, 0.05)).toBe(false); // +4.3%
  });

  it('rejects impossible inputs', () => {
    expect(() => slipEdge(1.2, 1.5)).toThrow();
    expect(() => slipEdge(0.5, 1)).toThrow();
  });

  it('fair probabilities remove the margin and sum to 1', () => {
    const p = fairProbs([1.9, 3.6, 4.2]);
    expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    expect(p[0]).toBeLessThan(1 / 1.9);
  });
});

describe('model fitting', () => {
  // Synthetic league: "Strong" scores 3 at home, everyone else 1-1.
  const teams = ['Strong', 'B', 'C', 'D', 'E', 'F'];
  const records: MatchRecord[] = [];
  let day = 1;
  for (let rep = 0; rep < 4; rep++) {
    for (const h of teams) for (const a of teams) {
      if (h === a) continue;
      const date = `2026-0${1 + (day % 8)}-${String(1 + (day % 27)).padStart(2, '0')}`;
      day++;
      const hg = h === 'Strong' ? 3 : 1, ag = a === 'Strong' ? 2 : 1;
      records.push({ league: 'X', date, home: h, away: a, hg, ag, hthg: Math.floor(hg / 2), htag: 0, stats: {}, odds: {} });
    }
  }
  const opts = { decayPerDay: 0, shrinkage: 1, asOf: new Date('2026-12-01') };

  it('rates the strong attack above the rest', () => {
    const m = fitCountModel('goals', 'X', records, (r) => [r.hg, r.ag], opts)!;
    expect(m.teams.Strong.for).toBeGreaterThan(m.teams.B.for * 1.5);
    const [lh] = expectedCounts(m, 'Strong', 'B')!;
    expect(lh).toBeGreaterThan(2);
  });

  it('returns null for a team it has not seen', () => {
    const m = fitCountModel('goals', 'X', records, (r) => [r.hg, r.ag], opts)!;
    expect(expectedCounts(m, 'Promoted', 'B')).toBeNull();
  });

  it('fits a goals model with a valid rho and half-time share', () => {
    const g = fitGoalsModel('X', records, opts)!;
    expect(g.rho).toBeGreaterThanOrEqual(-0.25);
    expect(g.rho).toBeLessThanOrEqual(0.15);
    expect(g.firstHalfShare).toBeGreaterThan(0);
    expect(g.firstHalfShare).toBeLessThan(1);
  });
});
