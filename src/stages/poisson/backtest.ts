import { MatchRecord } from './history';
import { fitGoalsModel, GoalsModel, scoreMatrix } from './dixonColes';
import { expectedCounts } from './countModel';
import { probWhere, pred } from './markets';
import { impliedGoalLambdas, blend } from './marketBlend';

/**
 * Walk-forward backtest of the goals model.
 *
 * The pipeline prices a match from two expected-goal rates — the model's and the market's —
 * blended by `modelWeight` (see marketBlend); in production that weight comes from this
 * backtest, so every candidate weight is scored on real history. For every past matchday the
 * goals model is refit on everything strictly before that day, then its 1X2 and over/under
 * 2.5 predictions are scored on the played results: log loss and Brier score per weight.
 *
 * The scoring math is pure data in, pure numbers out: the unit tests run it on a tiny
 * hand-made league; only the CLI (`npm run backtest`) downloads or reads real history.
 */

/** Fair (margin-removed) feed prices for one past match; either side may be missing. */
export interface BacktestMarket {
  oneX2: [number, number, number] | null; // [home, draw, away]
  ou25: [number, number] | null;          // [over, under]
}

/** One past match to be predicted: the played result plus any feed prices. */
export interface BacktestMatch {
  date: string;
  home: string;
  away: string;
  hg: number;
  ag: number;
  market: BacktestMarket;
}

export interface BacktestOptions {
  decayPerDay: number;
  shrinkage: number;
}

/** Score for one market, or null when nothing could be scored. */
export type Metric = { logLoss: number; brier: number } | null;

/**
 * Log loss and Brier score of `probs` against the played `outcomes`.
 *
 * `probs[i]` is the model's full probability vector for match i; `outcomes[i]` the index of
 * the outcome that was played (0..k-1). Nulls on either side skip the match. Log loss is the
 * mean of -ln p[outcome]; Brier is the mean, over the k outcomes, of sum_i (p[j] - 1{j played})^2,
 * so a uniform vector scores 1 - 1/k.
 */
export function logLossBrier(outcomes: (number | null)[], probs: (number[] | null)[], k: number): Metric {
  let n = 0, llSum = 0, brierSum = 0;
  for (let i = 0; i < outcomes.length; i++) {
    const o = outcomes[i], p = probs[i];
    if (o == null || p == null || p.length !== k) continue;
    llSum += -Math.log(Math.max(p[o], 1e-12));
    for (let j = 0; j < k; j++) brierSum += (p[j] - (j === o ? 1 : 0)) ** 2;
    n++;
  }
  if (!n) return null;
  return { logLoss: llSum / n, brier: brierSum / (n * k) };
}

/** Group chronologically sorted records into matchdays, keeping order. */
export function groupByDay<T extends { date: string }>(records: T[]): [string, T[]][] {
  const out: [string, T[]][] = [];
  for (const r of records) {
    const last = out[out.length - 1];
    if (last && last[0] === r.date) last[1].push(r);
    else out.push([r.date, [r]]);
  }
  return out;
}

/**
 * Weighted mean of (value, weight) pairs, or null when no positive weight.
 * Used to fold per-day averages into an overall average (each day weighted by its matches).
 */
export function weightedMean(pairs: [number, number][]): number | null {
  let sw = 0, s = 0;
  for (const [m, w] of pairs) { sw += w; s += m * w; }
  return sw > 0 ? s / sw : null;
}

/**
 * 1X2 and over/under 2.5 probabilities for one fixture.
 *
 * When feed prices exist they are converted to implied goal rates and blended with the
 * model's rates exactly like the live pipeline (see marketBlend); without prices the model
 * stands alone. Null when the model cannot rate the fixture.
 */
export function predictMatch(
  model: GoalsModel,
  home: string,
  away: string,
  market: BacktestMarket,
  modelWeight: number,
): { oneX2: number[]; ou25: number[] } | null {
  const g = expectedCounts(model, home, away);
  if (!g) return null;
  let [mh, ma] = g;
  if (market.oneX2 || market.ou25) {
    // Without 1X2 prices the market's home/away are unknown, so the O/U 2.5 share alone is
    // what pins the implied rates (impliedGoalLambdas solves them out of the draw-free half).
    const mk = impliedGoalLambdas(
      market.oneX2
        ? { home: market.oneX2[0], away: market.oneX2[2] }
        : { home: 1 / 3, away: 1 / 3, over25: market.ou25 ? market.ou25[0] : undefined },
      model.rho,
    );
    mh = blend(mh, mk[0], modelWeight);
    ma = blend(ma, mk[1], modelWeight);
  }
  const m = scoreMatrix(mh, ma, model.rho);
  return {
    oneX2: [probWhere(m, pred.home()), probWhere(m, pred.draw()), probWhere(m, pred.away())],
    ou25: [probWhere(m, pred.over(2.5)), probWhere(m, pred.under(2.5))],
  };
}

/**
 * Score one matchday at every weight in `weights`.
 *
 * `history` must strictly precede every test match; the goals model is refitted once on it
 * (asOf = the test day).
 */
export function backtestOneDay(
  league: string,
  history: MatchRecord[],
  testMatches: BacktestMatch[],
  weights: number[],
  opts: BacktestOptions,
): { oneX2: Map<number, Metric>; ou25: Map<number, Metric> } {
  const asOf = new Date(`${testMatches[0].date}T00:00:00Z`);
  const oneX2 = new Map<number, Metric>();
  const ou25 = new Map<number, Metric>();
  const model = fitGoalsModel(league, history, { ...opts, asOf });
  if (!model) {
    for (const w of weights) { oneX2.set(w, null); ou25.set(w, null); }
    return { oneX2, ou25 };
  }
  for (const w of weights) {
    const ps = testMatches.map((t) => predictMatch(model, t.home, t.away, t.market, w));
    const o1 = testMatches.map((t, i) => (ps[i] ? (t.hg > t.ag ? 0 : t.hg === t.ag ? 1 : 2) : null));
    const p1 = ps.map((p) => p?.oneX2 ?? null);
    oneX2.set(w, logLossBrier(o1, p1, 3));
    const oo = testMatches.map((t, i) => (ps[i] ? (t.hg + t.ag > 2.5 ? 0 : 1) : null));
    const po = ps.map((p) => p?.ou25 ?? null);
    ou25.set(w, logLossBrier(oo, po, 2));
  }
  return { oneX2, ou25 };
}

export interface BacktestReport {
  days: [string, Record<string, Metric>][];
  /** Totals per weight (match-by-match averages across all days). */
  totals: Record<string, { oneX2: Metric; ou25: Metric }>;
}

/**
 * Full walk-forward backtest over one league's history (sorted by date).
 *
 * For every matchday the goals model is refit on strictly earlier history, so no result
 * leaks into its own prediction. `toMatch` turns each history record into a test match (the
 * CLI supplies the feed prices read from the same CSV; tests pass a constant null market).
 */
export function runBacktest(
  league: string,
  history: MatchRecord[],
  toMatch: (r: MatchRecord) => BacktestMatch,
  weights: number[],
  opts: BacktestOptions,
): BacktestReport {
  const daysIn = groupByDay(history);
  const key = (w: number) => `w=${w}`;
  // Per weight: running sums folded into totals at the end. Each day contributes
  // its per-match total for log loss and its (k x matches) total for Brier.
  const acc = new Map<number, { ll1: number; bs1: number; n1: number; llo: number; bso: number; no: number }>();
  for (const w of weights) acc.set(w, { ll1: 0, bs1: 0, n1: 0, llo: 0, bso: 0, no: 0 });

  const days: BacktestReport['days'] = [];
  let prefix = 0;
  for (const [date, records] of daysIn) {
    const res = backtestOneDay(league, history.slice(0, prefix), records.map(toMatch), weights, opts);
    const row: Record<string, Metric> = {};
    for (const w of weights) {
      const o = res.oneX2.get(w) ?? null, u = res.ou25.get(w) ?? null;
      row[`1X2 ${key(w)}`] = o;
      row[`OU  ${key(w)}`] = u;
      const a = acc.get(w)!;
      const nn = records.length;
      if (o) { a.ll1 += o.logLoss * nn; a.bs1 += o.brier * nn * 3; a.n1 += nn; }
      if (u) { a.llo += u.logLoss * nn; a.bso += u.brier * nn * 2; a.no += nn; }
    }
    days.push([date, row]);
    prefix += records.length;
  }

  const totals: BacktestReport['totals'] = {};
  for (const w of weights) {
    const a = acc.get(w)!;
    totals[key(w)] = {
      oneX2: a.n1 ? { logLoss: a.ll1 / a.n1, brier: a.bs1 / (a.n1 * 3) } : null,
      ou25: a.no ? { logLoss: a.llo / a.no, brier: a.bso / (a.no * 2) } : null,
    };
  }
  return { days, totals };
}
