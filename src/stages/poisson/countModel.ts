import { MatchRecord } from './history';

/**
 * Team-strength model for one count statistic (goals, corners, cards, shots...).
 *
 *     E[home count] = baseHome x for[home] x against[away]
 *     E[away count] = baseAway x for[away] x against[home]
 *
 * `baseHome / baseAway` is the home advantage. Each match is weighted by
 * exp(-decayPerDay x age), so recent form counts more, and every team carries `shrinkage`
 * pseudo-matches at the league average so a handful of results cannot produce an extreme
 * rating. Fitted by iterative proportional scaling, which is the maximum-likelihood
 * solution of this Poisson log-linear model (without the shrinkage term).
 */
export interface TeamRating { for: number; against: number; matches: number }

export interface CountModel {
  stat: string;
  league: string;
  baseHome: number;
  baseAway: number;
  /** Variance / mean of the residuals; > 1 means over-dispersed (negative binomial). */
  dispersion: number;
  teams: Record<string, TeamRating>;
  fittedTo: string; // date of the newest match used
}

export interface FitOptions {
  decayPerDay: number;
  shrinkage: number;
  asOf: Date;
}

type Getter = (r: MatchRecord) => [number, number] | undefined;

export function matchWeight(date: string, asOf: Date, decayPerDay: number): number {
  const age = (asOf.getTime() - Date.parse(`${date}T12:00:00Z`)) / 86400_000;
  return Math.exp(-decayPerDay * Math.max(0, age));
}

export function fitCountModel(stat: string, league: string, records: MatchRecord[], get: Getter, opts: FitOptions): CountModel | null {
  const asOfDay = opts.asOf.toISOString().slice(0, 10);
  const rows = records
    .filter((r) => r.date < asOfDay)
    .map((r) => ({ r, y: get(r), w: matchWeight(r.date, opts.asOf, opts.decayPerDay) }))
    .filter((x): x is { r: MatchRecord; y: [number, number]; w: number } => !!x.y);
  if (rows.length < 30) return null;

  const teams: Record<string, TeamRating> = {};
  for (const { r } of rows) {
    for (const t of [r.home, r.away]) {
      teams[t] ??= { for: 1, against: 1, matches: 0 };
      teams[t].matches++;
    }
  }

  const sw = rows.reduce((s, x) => s + x.w, 0);
  let baseHome = rows.reduce((s, x) => s + x.w * x.y[0], 0) / sw;
  let baseAway = rows.reduce((s, x) => s + x.w * x.y[1], 0) / sw;
  const k = opts.shrinkage;

  for (let iter = 0; iter < 60; iter++) {
    const forNum: Record<string, number> = {}, forDen: Record<string, number> = {};
    const agNum: Record<string, number> = {}, agDen: Record<string, number> = {};
    for (const { r, y, w } of rows) {
      const h = teams[r.home], a = teams[r.away];
      forNum[r.home] = (forNum[r.home] ?? 0) + w * y[0];
      forDen[r.home] = (forDen[r.home] ?? 0) + w * baseHome * a.against;
      forNum[r.away] = (forNum[r.away] ?? 0) + w * y[1];
      forDen[r.away] = (forDen[r.away] ?? 0) + w * baseAway * h.against;
      agNum[r.away] = (agNum[r.away] ?? 0) + w * y[0];
      agDen[r.away] = (agDen[r.away] ?? 0) + w * baseHome * h.for;
      agNum[r.home] = (agNum[r.home] ?? 0) + w * y[1];
      agDen[r.home] = (agDen[r.home] ?? 0) + w * baseAway * a.for;
    }
    // The pseudo-matches add k games played exactly at the league average (rating 1).
    for (const t of Object.keys(teams)) {
      teams[t].for = (forNum[t] + k) / (forDen[t] + k);
      teams[t].against = (agNum[t] + k) / (agDen[t] + k);
    }
    // Pin the geometric mean of each rating set to 1 so the bases carry the scale.
    const names = Object.keys(teams);
    const gm = (f: (t: TeamRating) => number) => Math.exp(names.reduce((s, n) => s + Math.log(f(teams[n])), 0) / names.length);
    const gf = gm((t) => t.for), ga = gm((t) => t.against);
    for (const n of names) { teams[n].for /= gf; teams[n].against /= ga; }

    let numH = 0, denH = 0, numA = 0, denA = 0;
    for (const { r, y, w } of rows) {
      numH += w * y[0]; denH += w * teams[r.home].for * teams[r.away].against;
      numA += w * y[1]; denA += w * teams[r.away].for * teams[r.home].against;
    }
    baseHome = numH / denH;
    baseAway = numA / denA;
  }

  let pearson = 0, wsum = 0;
  for (const { r, y, w } of rows) {
    const lh = baseHome * teams[r.home].for * teams[r.away].against;
    const la = baseAway * teams[r.away].for * teams[r.home].against;
    pearson += w * ((y[0] - lh) ** 2 / Math.max(lh, 1e-6) + (y[1] - la) ** 2 / Math.max(la, 1e-6));
    wsum += 2 * w;
  }

  return {
    stat, league, baseHome, baseAway,
    dispersion: Math.max(1, pearson / wsum),
    teams,
    fittedTo: rows[rows.length - 1].r.date,
  };
}

/**
 * Expected counts for a fixture, or null when either side has too little history to rate —
 * a newly promoted team would otherwise be priced as exactly league-average, which is the
 * kind of quiet error this pipeline exists to avoid.
 */
export function expectedCounts(m: CountModel, home: string, away: string, minMatches = 5): [number, number] | null {
  const h = m.teams[home], a = m.teams[away];
  if (!h || !a || h.matches < minMatches || a.matches < minMatches) return null;
  return [m.baseHome * h.for * a.against, m.baseAway * a.for * h.against];
}
