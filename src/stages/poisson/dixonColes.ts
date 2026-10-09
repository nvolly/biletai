import { MatchRecord } from './history';
import { CountModel, FitOptions, fitCountModel, matchWeight } from './countModel';
import { poissonPmf } from './distributions';

export const MAX_GOALS = 10;

/**
 * Goals model: the shared team-strength fit plus the Dixon-Coles low-score correction.
 *
 * Independent Poissons misprice 0-0, 1-0, 0-1 and 1-1: real low-scoring matches are more
 * often drawn than independence predicts (teams protecting a lead, cagey games). Dixon &
 * Coles (1997) multiply those four cells by tau(x, y; rho) and leave every other score
 * alone, with rho fitted by likelihood. rho < 0 is the usual finding and raises 0-0 / 1-1.
 */
export interface GoalsModel extends CountModel {
  rho: number;
  /** Share of goals scored before half-time; splits simulated full-time goals into halves. */
  firstHalfShare: number;
}

export function tau(h: number, a: number, lh: number, la: number, rho: number): number {
  if (h === 0 && a === 0) return 1 - lh * la * rho;
  if (h === 0 && a === 1) return 1 + lh * rho;
  if (h === 1 && a === 0) return 1 + la * rho;
  if (h === 1 && a === 1) return 1 - rho;
  return 1;
}

/** rho must keep every tau positive for the expected goals it is applied to. */
function rhoBounds(lh: number, la: number): [number, number] {
  const lo = Math.max(-1 / Math.max(lh, 1e-9), -1 / Math.max(la, 1e-9));
  const hi = Math.min(1 / Math.max(lh * la, 1e-9), 1);
  return [lo, hi];
}

/**
 * Joint scoreline distribution 0..MAX_GOALS each side; probabilities sum to 1.
 * The tail beyond MAX_GOALS is renormalised away (it carries ~1e-6 mass at realistic rates).
 */
export function scoreMatrix(lh: number, la: number, rho: number): number[][] {
  const [lo, hi] = rhoBounds(lh, la);
  const r = Math.min(hi, Math.max(lo, rho));
  const ph = Array.from({ length: MAX_GOALS + 1 }, (_, k) => poissonPmf(lh, k));
  const pa = Array.from({ length: MAX_GOALS + 1 }, (_, k) => poissonPmf(la, k));
  const m: number[][] = [];
  let total = 0;
  for (let h = 0; h <= MAX_GOALS; h++) {
    m[h] = [];
    for (let a = 0; a <= MAX_GOALS; a++) {
      m[h][a] = ph[h] * pa[a] * tau(h, a, lh, la, r);
      total += m[h][a];
    }
  }
  for (let h = 0; h <= MAX_GOALS; h++) for (let a = 0; a <= MAX_GOALS; a++) m[h][a] /= total;
  return m;
}

export function fitGoalsModel(league: string, records: MatchRecord[], opts: FitOptions): GoalsModel | null {
  const base = fitCountModel('goals', league, records, (r) => [r.hg, r.ag], opts);
  if (!base) return null;

  const asOfDay = opts.asOf.toISOString().slice(0, 10);
  const rows = records.filter((r) => r.date < asOfDay && base.teams[r.home] && base.teams[r.away]);

  // rho by weighted likelihood on a grid; only the tau term depends on it.
  let bestRho = 0, bestLL = -Infinity;
  for (let rho = -0.25; rho <= 0.15 + 1e-9; rho += 0.005) {
    let ll = 0;
    for (const r of rows) {
      if (r.hg > 1 || r.ag > 1) continue;
      const lh = base.baseHome * base.teams[r.home].for * base.teams[r.away].against;
      const la = base.baseAway * base.teams[r.away].for * base.teams[r.home].against;
      const t = tau(r.hg, r.ag, lh, la, rho);
      if (t <= 0) { ll = -Infinity; break; }
      ll += matchWeight(r.date, opts.asOf, opts.decayPerDay) * Math.log(t);
    }
    if (ll > bestLL) { bestLL = ll; bestRho = rho; }
  }

  let ht = 0, ft = 0;
  for (const r of rows) {
    if (r.hthg == null || r.htag == null) continue;
    const w = matchWeight(r.date, opts.asOf, opts.decayPerDay);
    ht += w * (r.hthg + r.htag);
    ft += w * (r.hg + r.ag);
  }

  return { ...base, rho: Number(bestRho.toFixed(3)), firstHalfShare: ft > 0 ? ht / ft : 0.45 };
}
