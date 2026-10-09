import { MatchRecord, StatKey } from './history';
import { negBinPmf, normInv, rng } from './distributions';

/**
 * The simulation's dependence structure: a Gaussian copula over these per-team counts.
 *
 * Each model gives a marginal distribution (how many corners Arsenal take), but the slip
 * needs the JOINT behaviour (a match with many goals tends to have many shots, and a team
 * chasing the game wins corners). That dependence is measured, not assumed: every past
 * match's counts are turned into normal scores relative to what the models expected for
 * that match, and the correlation of those scores across matches is the copula.
 */
export const SIM_VARS = [
  'goalsH', 'goalsA', 'shotsH', 'shotsA', 'sotH', 'sotA',
  'cornersH', 'cornersA', 'cardsH', 'cardsA', 'redsH', 'redsA',
] as const;
export type SimVar = typeof SIM_VARS[number];
export const VAR_INDEX: Record<SimVar, number> = Object.fromEntries(SIM_VARS.map((v, i) => [v, i])) as any;

export const STAT_VARS: Record<StatKey, [SimVar, SimVar]> = {
  shots: ['shotsH', 'shotsA'], sot: ['sotH', 'sotA'], corners: ['cornersH', 'cornersA'],
  cards: ['cardsH', 'cardsA'], reds: ['redsH', 'redsA'],
};

export type Expected = Partial<Record<SimVar, { mean: number; dispersion: number }>>;

/** Randomised PIT: maps a discrete observation to a uniform, then to a normal score. */
function normalScore(y: number, mean: number, dispersion: number, u: number): number {
  let below = 0;
  for (let k = 0; k < y; k++) below += negBinPmf(mean, dispersion, k);
  const at = negBinPmf(mean, dispersion, y);
  const p = Math.min(1 - 1e-9, Math.max(1e-9, below + u * at));
  return normInv(p);
}

export function identity(n: number): number[][] {
  return Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
}

/**
 * Correlation of normal scores across past matches. `expected(r)` returns the models'
 * means for that match, or null to skip it. Home/away goals are forced to 0: their
 * dependence is already carried exactly by the Dixon-Coles matrix the goals are drawn from.
 */
export function estimateCorrelation(records: MatchRecord[], expected: (r: MatchRecord) => Expected | null, seed = 7): number[][] {
  const d = SIM_VARS.length;
  const rand = rng(seed);
  const cross = identity(d).map((row) => row.map(() => 0));

  const observed = (r: MatchRecord, v: SimVar): number | undefined => {
    if (v === 'goalsH') return r.hg;
    if (v === 'goalsA') return r.ag;
    for (const [stat, pair] of Object.entries(STAT_VARS)) {
      const s = r.stats[stat as StatKey];
      if (s && pair[0] === v) return s[0];
      if (s && pair[1] === v) return s[1];
    }
    return undefined;
  };

  const zs: (number | null)[][] = [];
  for (const r of records) {
    const e = expected(r);
    if (!e) continue;
    zs.push(SIM_VARS.map((v) => {
      const y = observed(r, v), m = e[v];
      return y == null || !m ? null : normalScore(y, m.mean, m.dispersion, rand());
    }));
  }

  // Pairwise-complete Pearson: leagues without stat columns still inform the goals block.
  for (let i = 0; i < d; i++) for (let j = 0; j < d; j++) {
    let n = 0, si = 0, sj = 0, sii = 0, sjj = 0, sij = 0;
    for (const z of zs) {
      if (z[i] == null || z[j] == null) continue;
      n++; si += z[i]!; sj += z[j]!; sii += z[i]! ** 2; sjj += z[j]! ** 2; sij += z[i]! * z[j]!;
    }
    if (n < 50) { cross[i][j] = i === j ? 1 : 0; continue; }
    const cov = sij / n - (si / n) * (sj / n);
    const vi = sii / n - (si / n) ** 2, vj = sjj / n - (sj / n) ** 2;
    cross[i][j] = i === j ? 1 : cov / Math.sqrt(vi * vj);
  }

  const gH = VAR_INDEX.goalsH, gA = VAR_INDEX.goalsA;
  cross[gH][gA] = cross[gA][gH] = 0;
  return nearestCorrelation(cross);
}

/** Symmetric eigen-decomposition (cyclic Jacobi); fine for a 12x12 matrix. */
function jacobiEigen(a: number[][]): { values: number[]; vectors: number[][] } {
  const n = a.length;
  const m = a.map((r) => r.slice());
  const v = identity(n);
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += m[i][j] ** 2;
    if (off < 1e-18) break;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
      if (Math.abs(m[p][q]) < 1e-15) continue;
      const theta = (m[q][q] - m[p][p]) / (2 * m[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < n; k++) {
        const mkp = m[k][p], mkq = m[k][q];
        m[k][p] = c * mkp - s * mkq; m[k][q] = s * mkp + c * mkq;
      }
      for (let k = 0; k < n; k++) {
        const mpk = m[p][k], mqk = m[q][k];
        m[p][k] = c * mpk - s * mqk; m[q][k] = s * mpk + c * mqk;
      }
      for (let k = 0; k < n; k++) {
        const vkp = v[k][p], vkq = v[k][q];
        v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq;
      }
    }
  }
  return { values: m.map((r, i) => r[i]), vectors: v };
}

/**
 * Pairwise estimates and the forced zero can leave the matrix slightly indefinite, which
 * would break the Cholesky factor. Clip negative eigenvalues and restore the unit diagonal.
 */
export function nearestCorrelation(a: number[][]): number[][] {
  const n = a.length;
  const { values, vectors } = jacobiEigen(a);
  const clipped = values.map((x) => Math.max(x, 1e-6));
  const out = identity(n).map((r) => r.map(() => 0));
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    let s = 0;
    for (let k = 0; k < n; k++) s += vectors[i][k] * clipped[k] * vectors[j][k];
    out[i][j] = s;
  }
  const dg = out.map((r, i) => Math.sqrt(r[i]));
  return out.map((r, i) => r.map((x, j) => (i === j ? 1 : x / (dg[i] * dg[j]))));
}

export function cholesky(a: number[][]): number[][] {
  const n = a.length;
  const l = identity(n).map((r) => r.map(() => 0));
  for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) {
    let s = a[i][j];
    for (let k = 0; k < j; k++) s -= l[i][k] * l[j][k];
    l[i][j] = i === j ? Math.sqrt(Math.max(s, 1e-12)) : s / l[j][j];
  }
  return l;
}
