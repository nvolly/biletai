import { describe, it, expect } from '@jest/globals';
import { simulate } from '../stages/poisson/simulate';
import { identity, SIM_VARS, cholesky } from '../stages/poisson/copula';
import { catalogue } from './catalogue';
import { buildBest, candidates, BuilderOptions } from './builder';

const model = {
  goals: { lh: 1.7, la: 1.0, rho: -0.05, firstHalfShare: 0.45 },
  counts: { corners: { lh: 5.8, la: 4.2, dispersion: 1.3 }, cards: { lh: 1.9, la: 2.2, dispersion: 1.2 } },
};
const sim = simulate(model, cholesky(identity(SIM_VARS.length)), 20000, 42);
const opts: BuilderOptions = { minLegs: 2, maxLegs: 4, minOdds: 1.25, maxOdds: 2, legMinOdds: 1.05, maxCandidateLegs: 40, beamWidth: 8 };
const available = new Set(['goals', 'corners', 'cards']);

describe('builder', () => {
  const pool = candidates(sim, catalogue('Home FC', 'Away FC'), available, opts);

  it('only offers selections the models cover, inside the leg limits', () => {
    expect(pool.length).toBeGreaterThan(10);
    for (const c of pool) {
      expect(c.sel.needs.every((n) => available.has(n))).toBe(true);
      expect(c.p).toBeLessThan(1 / opts.legMinOdds);
      expect(c.p).toBeGreaterThan(1 / opts.maxOdds);
    }
    expect(pool.some((c) => c.sel.family.startsWith('shots'))).toBe(false); // no shots model here
  });

  it('builds combinations inside the fair-odds band, one selection per market family', () => {
    for (const [lo, hi] of [[1.25, 1.46], [1.46, 1.71], [1.71, 2]]) {
      const [b] = buildBest(sim, pool, { ...opts, minOdds: lo, maxOdds: hi });
      expect(b).toBeDefined();
      expect(b.fairOdds).toBeGreaterThanOrEqual(lo - 1e-9);
      expect(b.fairOdds).toBeLessThanOrEqual(hi + 1e-9);
      expect(b.legs.length).toBeGreaterThanOrEqual(2);
      expect(new Set(b.legs.map((l) => l.family)).size).toBe(b.legs.length);
    }
  });

  it('simple bets: exactly one selection per match, inside the odds band', () => {
    // As generate() does for simple bets: every selection in range, not just the likeliest 40.
    const single = { ...opts, minLegs: 1, maxLegs: 1, maxCandidateLegs: Number.MAX_SAFE_INTEGER };
    const singles = candidates(sim, catalogue('Home FC', 'Away FC'), available, single);
    for (const [lo, hi] of [[1.25, 1.46], [1.46, 1.71], [1.71, 2]]) {
      const [b] = buildBest(sim, singles, { ...single, minOdds: lo, maxOdds: hi });
      expect(b).toBeDefined();
      expect(b.legs.length).toBe(1);
      expect(b.fairOdds).toBeGreaterThanOrEqual(lo - 1e-9);
      expect(b.fairOdds).toBeLessThanOrEqual(hi + 1e-9);
      expect(b.probability).toBeCloseTo(b.legs[0].probability, 12);
    }
  });

  it('reads the joint probability from the simulation, not the product of the legs', () => {
    const [b] = buildBest(sim, pool, opts);
    const product = b.legs.reduce((a, l) => a * l.probability, 1);
    expect(Math.abs(b.probability - product)).toBeGreaterThan(0); // correlation shows up
    expect(b.fairOdds).toBeCloseTo(1 / b.probability, 10);
  });

  it('never pads a builder with a selection that barely changes the probability', () => {
    const [b] = buildBest(sim, pool, opts);
    for (let k = 1; k < b.legs.length; k++) {
      const without = b.legs.filter((_, i) => i !== k);
      const p = jointOf(without.map((l) => l.id));
      expect(b.probability).toBeLessThan(p * (1 - 0.02) + 1e-9);
    }
  });
});

function jointOf(ids: string[]): number {
  const sels = catalogue('Home FC', 'Away FC').filter((s) => ids.includes(s.id));
  let k = 0;
  for (let i = 0; i < sim.n; i++) if (sels.every((s) => s.test(sim, i))) k++;
  return k / sim.n;
}
