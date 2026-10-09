import { noul, choice } from '@typesafe-ai/sdk';
import { settings } from '../../config/config';
import { logger } from '../../utils/logger';
import { MatchNews, FatalPipelineError } from '../news/newsAgent';
import { evaluate, logDecision } from './client';

/**
 * Jev (TypeSafe's decision model) decides whether a match is safe to trust and
 * sanity-checks the finished builder. It never picks selections — the models do.
 *
 * Jev cannot do arithmetic, so every number arrives as a finished percentage; and question
 * keys are never sent to the model, so each question carries its full meaning in its text.
 */
export interface MatchState {
  eventId: string;
  match: string;
  competition: string;
  kickoff: string;
  news: MatchNews | null;
  form: { home: string; away: string };
  market: Record<string, string>; // e.g. { home_win: "1.40 (71% implied)" }
}

function baseState(m: MatchState) {
  return {
    match: m.match,
    competition: m.competition,
    kickoff_utc: m.kickoff,
    recent_form: m.form,
    team_news: m.news ?? 'No news summary could be found for this match.',
    average_market_prices: m.market,
  };
}

export interface MatchVerdict {
  keep: boolean;
  reasons: string[];
  /** Multiplier (<= 1) applied to the builder's probability: Jev's risk discount. */
  weight: number;
  flags: { keyPlayerMissing: number; rotation: number; infoLow: number; riskHigh: number; riskMedium: number };
}

/** Role 1: should this match be on a ticket at all? */
export async function filterMatch(m: MatchState): Promise<MatchVerdict> {
  const state = baseState(m);
  const questions = {
    key_player_missing: noul(
      'A player who normally starts and matters most to his team\'s results will miss this match (injury, suspension or rest).',
      { true: 'At least one such key player is confirmed or very likely out.', false: 'Both teams have their key players available.' },
    ),
    likely_rotation: noul(
      'Either team is likely to leave out several regular starters, for example because a more important match follows within a few days.',
      { true: 'Significant rotation is expected.', false: 'Both teams are expected to field close to their strongest side.' },
    ),
    info_quality: choice('How complete and trustworthy is the available team news for this match?', {
      low: 'Little or no recent team news; lineups and absences are unknown.',
      medium: 'Some recent news, but important details are unconfirmed.',
      high: 'Recent, consistent news covering absences and the likely lineups of both teams.',
    }),
    risk_level: choice('How likely is this match to play out differently from what the teams\' normal strength and the market prices suggest?', {
      low: 'A normal match between two settled sides at full strength.',
      medium: 'Some unusual factor (absences, motivation, weather, a new coach) could shift it.',
      high: 'Strong reasons to expect an atypical match: heavy rotation, dead rubber, crisis, or very little information.',
    }),
  };

  const flags = { keyPlayerMissing: 0, rotation: 0, infoLow: 0, riskHigh: 0, riskMedium: 0 };
  try {
    const res = await evaluate(state, questions);
    const a = res.answers;
    flags.keyPlayerMissing = a.key_player_missing?.noul ?? 0;
    flags.rotation = a.likely_rotation?.noul ?? 0;
    flags.infoLow = a.info_quality?.probabilities?.low ?? 0;
    flags.riskHigh = a.risk_level?.probabilities?.high ?? 0;
    flags.riskMedium = a.risk_level?.probabilities?.medium ?? 0;

    const j = settings.jev;
    const reasons: string[] = [];
    if (flags.keyPlayerMissing >= j.dropIfKeyPlayerMissing) reasons.push(`key player missing ${(flags.keyPlayerMissing * 100).toFixed(0)}%`);
    if (flags.rotation >= j.dropIfRotation) reasons.push(`rotation ${(flags.rotation * 100).toFixed(0)}%`);
    if (flags.infoLow >= j.dropIfLowInfo) reasons.push(`low info quality ${(flags.infoLow * 100).toFixed(0)}%`);
    if (flags.riskHigh >= j.dropIfHighRisk) reasons.push(`high risk ${(flags.riskHigh * 100).toFixed(0)}%`);
    const weight = 1 - j.riskDownweight * (flags.riskHigh + 0.5 * flags.riskMedium) - j.keyPlayerDownweight * flags.keyPlayerMissing;
    const verdict: MatchVerdict = { keep: reasons.length === 0, reasons, weight, flags };
    logDecision({ role: 'match-filter', eventId: m.eventId, match: m.match, state, questions, result: res, decision: verdict });
    return verdict;
  } catch (err: any) {
    if (err instanceof FatalPipelineError) throw err;
    // No verdict means no trust: a match Jev could not assess is dropped, not waved through.
    const verdict: MatchVerdict = { keep: false, reasons: [`jev unavailable: ${err?.message ?? err}`], weight: 0, flags };
    logDecision({ role: 'match-filter', eventId: m.eventId, match: m.match, state, questions, error: String(err?.message ?? err), decision: verdict });
    logger.warn(`jev match filter failed for ${m.match}: ${err?.message ?? err}`);
    return verdict;
  }
}

/** Role 2: do the chosen selections make sense together, given the news? */
export async function checkBuilder(m: MatchState, legs: { market: string; pick: string; probability: number }[], jointProbability: number): Promise<{ ok: boolean; consistency: number | null }> {
  const state = {
    ...baseState(m),
    selections: legs.map((l) => ({ market: l.market, selection: l.pick, model_probability: `${(l.probability * 100).toFixed(0)}%` })),
    probability_all_selections_win: `${(jointProbability * 100).toFixed(1)}%`,
  };
  const questions = {
    consistent: noul(
      'All of these selections can sensibly happen together in this match, and nothing in the team news makes any of them clearly less likely than its stated probability.',
      { true: 'The selections fit together and with the news.', false: 'Some selection conflicts with another or with the team news.' },
    ),
  };
  try {
    const res = await evaluate(state, questions);
    const consistency = res.answers.consistent?.noul ?? null;
    const ok = consistency != null && consistency >= settings.jev.minSlipConsistency;
    logDecision({ role: 'builder-check', eventId: m.eventId, match: m.match, state, questions, result: res, decision: { ok, consistency } });
    return { ok, consistency };
  } catch (err: any) {
    if (err instanceof FatalPipelineError) throw err;
    logDecision({ role: 'builder-check', eventId: m.eventId, match: m.match, state, questions, error: String(err?.message ?? err), decision: { ok: false } });
    logger.warn(`jev builder check failed for ${m.match}: ${err?.message ?? err}`);
    return { ok: false, consistency: null };
  }
}
