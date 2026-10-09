import { settings } from '../../config/config';
import { logger } from '../../utils/logger';
import { LEAGUES, LeagueDef } from './leagues';
import { loadLeagueHistory, MatchRecord, StatKey, STAT_KEYS, staleDays } from './history';
import { CountModel, expectedCounts, fitCountModel, FitOptions } from './countModel';
import { fitGoalsModel, GoalsModel } from './dixonColes';
import { cholesky, estimateCorrelation, Expected, identity, SIM_VARS, STAT_VARS } from './copula';
import { FixtureModel } from './simulate';

export interface LeagueModels {
  def: LeagueDef;
  records: MatchRecord[];
  goals: GoalsModel;
  counts: Partial<Record<StatKey, CountModel>>;
  staleDays: number;
}

export interface ModelBank {
  asOf: Date;
  leagues: Map<string, LeagueModels>;
  correlation: number[][];
  chol: number[][];
}

export function fitLeague(def: LeagueDef, records: MatchRecord[], opts: FitOptions): LeagueModels | null {
  const goals = fitGoalsModel(def.code, records, opts);
  if (!goals) return null;
  const counts: LeagueModels['counts'] = {};
  for (const stat of STAT_KEYS) {
    const m = fitCountModel(stat, def.code, records, (r) => r.stats[stat], opts);
    if (!m) continue;
    // Team red-card ratings showed no skill over the league rate in backtests: flatten them.
    if (stat === 'reds') for (const t of Object.values(m.teams)) { t.for = 1; t.against = 1; }
    counts[stat] = m;
  }
  return { def, records, goals, counts, staleDays: staleDays(records, opts.asOf) };
}

/** The models' expected means for one past match, used to estimate the copula. */
function expectedFor(lm: LeagueModels, r: MatchRecord): Expected | null {
  const g = expectedCounts(lm.goals, r.home, r.away);
  if (!g) return null;
  const e: Expected = { goalsH: { mean: g[0], dispersion: 1 }, goalsA: { mean: g[1], dispersion: 1 } };
  for (const [stat, m] of Object.entries(lm.counts) as [StatKey, CountModel][]) {
    const c = expectedCounts(m, r.home, r.away);
    if (!c) continue;
    const [vh, va] = STAT_VARS[stat];
    e[vh] = { mean: c[0], dispersion: m.dispersion };
    e[va] = { mean: c[1], dispersion: m.dispersion };
  }
  return e;
}

export async function buildModelBank(codes: string[] = LEAGUES.map((l) => l.code), asOf = new Date()): Promise<ModelBank> {
  const opts: FitOptions = { decayPerDay: settings.model.decayPerDay, shrinkage: settings.model.shrinkage, asOf };
  const leagues = new Map<string, LeagueModels>();
  const stale: string[] = [];
  for (const code of codes) {
    const def = LEAGUES.find((l) => l.code === code);
    if (!def) continue;
    const records = await loadLeagueHistory(def, settings.model.seasons, asOf);
    const lm = fitLeague(def, records, opts);
    if (!lm) { logger.warn(`model ${code}: not enough history (${records.length} matches) — league skipped`); continue; }
    if (lm.staleDays > settings.model.maxStaleDays) stale.push(`${code} ${lm.staleDays}d`);
    leagues.set(code, lm);
  }
  if (stale.length) {
    logger.warn(`results lag: newest result older than ${settings.model.maxStaleDays} days in ` +
      `${stale.length} league(s) (${stale.join(', ')}) — ratings miss the latest form`);
  }

  const pooled: { lm: LeagueModels; r: MatchRecord }[] = [];
  for (const lm of leagues.values()) for (const r of lm.records) pooled.push({ lm, r });
  const byRecord = new Map(pooled.map((p) => [p.r, p.lm]));
  const correlation = pooled.length
    ? estimateCorrelation(pooled.map((p) => p.r), (r) => expectedFor(byRecord.get(r)!, r))
    : identity(SIM_VARS.length);

  logger.info(`models: ${leagues.size} leagues fitted, copula from ${pooled.length} matches`);
  return { asOf, leagues, correlation, chol: cholesky(correlation) };
}

export type ResolvedFixture =
  | { ok: true; model: FixtureModel; modelled: ('goals' | StatKey)[] }
  | { ok: false; reason: string };

/**
 * Expected counts for one fixture. Fixtures come from the same data source as the history,
 * already tagged with their league and with identical team names, so no name matching.
 */
export function modelFor(bank: ModelBank, league: string, home: string, away: string): ResolvedFixture {
  const lm = bank.leagues.get(league);
  if (!lm) return { ok: false, reason: `no model for league ${league}` };
  const g = expectedCounts(lm.goals, home, away);
  if (!g) return { ok: false, reason: `too little history for ${home} or ${away}` };
  const model: FixtureModel = {
    goals: { lh: g[0], la: g[1], rho: lm.goals.rho, firstHalfShare: lm.goals.firstHalfShare },
    counts: {},
  };
  const modelled: ('goals' | StatKey)[] = ['goals'];
  for (const [stat, m] of Object.entries(lm.counts) as [StatKey, CountModel][]) {
    const c = expectedCounts(m, home, away);
    if (!c) continue;
    model.counts[stat] = { lh: c[0], la: c[1], dispersion: m.dispersion };
    modelled.push(stat);
  }
  return { ok: true, model, modelled };
}
