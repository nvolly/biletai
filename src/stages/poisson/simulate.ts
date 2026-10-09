import { StatKey } from './history';
import { scoreMatrix } from './dixonColes';
import { countTable, gaussian, normCdf, quantileFromTable, rng } from './distributions';
import { SIM_VARS, STAT_VARS, VAR_INDEX, SimVar } from './copula';

/**
 * Monte Carlo over whole matches, so legs priced by DIFFERENT models (goals, corners,
 * cards, shots) can be combined honestly.
 *
 * Each simulated match draws one correlated normal vector z = L·e (L = Cholesky factor of
 * the copula), then turns every component into a count through its own model's marginal.
 * A combination's probability is the share of simulated matches in which every leg wins —
 * so "over 2.5 goals + over 9.5 corners" picks up the measured goals/corners correlation
 * instead of pretending the two are independent.
 *
 * Goals are drawn from the Dixon-Coles matrix itself (home from the row sums, away from
 * the chosen row), which reproduces the matrix exactly; the copula keeps home/away goals
 * mutually uncorrelated for that reason and only ties them to the other stats.
 */
export interface FixtureModel {
  goals: { lh: number; la: number; rho: number; firstHalfShare: number };
  counts: Partial<Record<StatKey, { lh: number; la: number; dispersion: number }>>;
}

export interface Simulation {
  n: number;
  gh: Int16Array; ga: Int16Array;     // full-time goals
  gh1: Int16Array; ga1: Int16Array;   // first-half goals
  counts: Partial<Record<StatKey, [Int16Array, Int16Array]>>;
  /** The latent normal per variable; player legs couple to these. */
  z: Float32Array[];
  seed: number;
}

const MAX_COUNT: Record<StatKey, number> = { shots: 60, sot: 30, corners: 30, cards: 20, reds: 6 };

export function simulate(model: FixtureModel, chol: number[][], n: number, seed: number): Simulation {
  const rand = rng(seed);
  const d = SIM_VARS.length;
  const matrix = scoreMatrix(model.goals.lh, model.goals.la, model.goals.rho);
  const rowTotals = matrix.map((r) => r.reduce((a, b) => a + b, 0));
  const condRows = matrix.map((r, i) => r.map((x) => (rowTotals[i] > 0 ? x / rowTotals[i] : 0)));

  const tables: Partial<Record<SimVar, Float64Array>> = {};
  for (const [stat, m] of Object.entries(model.counts) as [StatKey, { lh: number; la: number; dispersion: number }][]) {
    const [vh, va] = STAT_VARS[stat];
    tables[vh] = countTable(m.lh, m.dispersion, MAX_COUNT[stat]);
    tables[va] = countTable(m.la, m.dispersion, MAX_COUNT[stat]);
  }

  const sim: Simulation = {
    n, seed,
    gh: new Int16Array(n), ga: new Int16Array(n), gh1: new Int16Array(n), ga1: new Int16Array(n),
    counts: {},
    z: SIM_VARS.map(() => new Float32Array(n)),
  };
  for (const stat of Object.keys(model.counts) as StatKey[]) sim.counts[stat] = [new Int16Array(n), new Int16Array(n)];

  const e = new Float64Array(d), z = new Float64Array(d);
  const share = model.goals.firstHalfShare;
  for (let s = 0; s < n; s++) {
    for (let i = 0; i < d; i++) e[i] = gaussian(rand);
    for (let i = 0; i < d; i++) {
      let acc = 0;
      for (let k = 0; k <= i; k++) acc += chol[i][k] * e[k];
      z[i] = acc;
      sim.z[i][s] = acc;
    }

    const h = quantileFromTable(rowTotals, normCdf(z[VAR_INDEX.goalsH]));
    const a = quantileFromTable(condRows[h], normCdf(z[VAR_INDEX.goalsA]));
    sim.gh[s] = h; sim.ga[s] = a;
    // Each goal independently falls in the first half with the league's measured share.
    let h1 = 0, a1 = 0;
    for (let g = 0; g < h; g++) if (rand() < share) h1++;
    for (let g = 0; g < a; g++) if (rand() < share) a1++;
    sim.gh1[s] = h1; sim.ga1[s] = a1;

    for (const stat of Object.keys(sim.counts) as StatKey[]) {
      const [vh, va] = STAT_VARS[stat];
      sim.counts[stat]![0][s] = quantileFromTable(tables[vh]!, normCdf(z[VAR_INDEX[vh]]));
      sim.counts[stat]![1][s] = quantileFromTable(tables[va]!, normCdf(z[VAR_INDEX[va]]));
    }
  }
  return sim;
}

export type Outcome = Uint8Array;

export function probability(o: Outcome): number {
  let k = 0;
  for (let i = 0; i < o.length; i++) k += o[i];
  return k / o.length;
}

/** P(every leg wins) — the share of simulated matches where all outcomes are 1. */
export function jointProbability(outcomes: Outcome[]): number {
  if (!outcomes.length) return 0;
  const n = outcomes[0].length;
  let k = 0;
  outer: for (let i = 0; i < n; i++) {
    for (const o of outcomes) if (!o[i]) continue outer;
    k++;
  }
  return k / n;
}
