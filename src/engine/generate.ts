import { settings } from '../config/config';
import { logger } from '../utils/logger';
import { ModelBank, modelFor } from '../stages/poisson/modelBank';
import { simulate } from '../stages/poisson/simulate';
import { hashSeed } from '../stages/poisson/distributions';
import { fairProbs } from '../stages/poisson/edge';
import { blend, impliedGoalLambdas } from '../stages/poisson/marketBlend';
import { getMatchNews, explainBuilder, FatalPipelineError, MatchNews } from '../stages/news/newsAgent';
import { filterMatch, checkBuilder, MatchState } from '../stages/jev/jevStage';
import { buildBest, candidates, Builder, BuilderOptions, Leg } from './builder';
import { catalogue } from './catalogue';
import { Fixture, FixtureSource, footballDataFixtures } from './fixtures';
import { Lang, MSG, reason } from '../i18n';
import type { MatchResult } from './settle';

/**
 * One generation: N tickets of M matches. Two bet types:
 *   - simple: one selection per match;
 *   - combo ("Combinat" in the app): a builder of 2-4 selections on that match.
 * Either way each match's fair odds fall in the requested band, and the ticket's odds are
 * cumulated over its matches.
 *
 *   fixtures -> models (+ market blend for goals) -> 20,000 simulated matches
 *   -> best builder per match in each odds band (free, seconds)
 *   -> AI, only for the matches about to be used: news, Jev risk filter, Jev consistency
 *      check, a short explanation -> tickets (matches dealt round-robin)
 *
 * Different matches are independent, so a ticket's probability and fair odds are the
 * products over its matches. Within a match, selections are never multiplied: the joint
 * probability comes from the simulation.
 */
export type BetType = 'simple' | 'combo';
export const asBetType = (v: unknown): BetType => (v === 'simple' ? 'simple' : 'combo');

export interface GenerateRequest {
  tickets: number;
  matches: number;           // per ticket
  betType?: BetType;         // default combo
  minOdds?: number;          // per match (fair odds of its selection or builder)
  maxOdds?: number;
  maxLegs?: number;
  windowHours?: number;
  leagues?: string[];        // model codes; empty = all
  ai?: boolean;
  lang?: Lang;               // language of everything the user sees (markets, progress, AI text)
}

export interface TicketMatch {
  fixture: Pick<Fixture, 'id' | 'league' | 'leagueName' | 'country' | 'home' | 'away' | 'kickoff'>;
  legs: Leg[];
  probability: number;       // model, all selections win
  adjusted: number;          // after Jev's risk discount (= probability without AI)
  fairOdds: number;
  explanation?: string;
  jev?: { risk: number; infoLow: number; consistency: number | null };
  result?: MatchResult;      // set by the results tracker once the match is played
}

export interface Ticket { index: number; matches: TicketMatch[]; probability: number; fairOdds: number; status?: 'won' | 'lost' }

export interface GenerationResult {
  createdAt: string;
  request: Required<Omit<GenerateRequest, 'leagues'>> & { leagues: string[] };
  tickets: Ticket[];
  found: number;
  needed: number;
  aiUsed: boolean;
  log: string[];
}

type Log = (line: string) => void;

function bands(lo: number, hi: number): [number, number][] {
  const r = Math.pow(hi / lo, 1 / 3);
  return [[lo, lo * r], [lo * r, lo * r * r], [lo * r * r, hi]];
}

function marketLabels(f: Fixture): Record<string, string> {
  const out: Record<string, string> = {};
  const put = (k: string, v?: number) => { if (v) out[k] = `${v.toFixed(2)} (${((1 / v) * 100).toFixed(0)}% implied)`; };
  put('home_win', f.market.home); put('draw', f.market.draw); put('away_win', f.market.away);
  put('over_2_5_goals', f.market.over25); put('under_2_5_goals', f.market.under25);
  return out;
}

interface Prepared { f: Fixture; byBand: (Builder | null)[] }

/** The free part for one fixture: models, market blend, simulation, best builder per band. */
function prepare(bank: ModelBank, f: Fixture, opts: BuilderOptions, bandList: [number, number][], lang: Lang): Prepared | string {
  const r = modelFor(bank, f.league, f.home, f.away);
  if (!r.ok) return `skip ${f.home} v ${f.away}: ${r.reason}`;
  const model = r.model;
  const m = f.market;
  if (m.home && m.draw && m.away) {
    const fp = fairProbs([m.home, m.draw, m.away]);
    const over25 = m.over25 && m.under25 ? fairProbs([m.over25, m.under25])[0] : undefined;
    const [lh, la] = impliedGoalLambdas({ home: fp[0], away: fp[2], over25 }, model.goals.rho);
    model.goals.lh = blend(model.goals.lh, lh, settings.model.modelWeight);
    model.goals.la = blend(model.goals.la, la, settings.model.modelWeight);
  }
  const sim = simulate(model, bank.chol, settings.model.simulations, hashSeed(f.id));
  const pool = candidates(sim, catalogue(f.home, f.away, lang), new Set(r.modelled), opts);
  const byBand = bandList.map(([lo, hi]) => buildBest(sim, pool, { ...opts, minOdds: lo, maxOdds: hi }, 1)[0] ?? null);
  return byBand.some(Boolean) ? { f, byBand } : `none ${f.home} v ${f.away}: no combination in the odds range`;
}

export async function generate(bank: ModelBank, req: GenerateRequest, onLog: Log = () => {}, source: FixtureSource = footballDataFixtures): Promise<GenerationResult> {
  const t = settings.tickets, b = settings.builder;
  const betType = asBetType(req.betType);
  const request = {
    tickets: Math.min(Math.max(1, Math.floor(req.tickets)), t.maxTickets),
    matches: Math.min(Math.max(1, Math.floor(req.matches)), t.maxMatches),
    betType,
    minOdds: req.minOdds ?? b.minOdds,
    maxOdds: req.maxOdds ?? b.maxOdds,
    maxLegs: betType === 'simple' ? 1 : Math.min(Math.max(b.minLegs, req.maxLegs ?? b.maxLegs), 5),
    windowHours: Math.min(req.windowHours ?? t.windowHours, 240),
    leagues: req.leagues ?? [],
    ai: (req.ai ?? true) && settings.ai.enabled,
    lang: req.lang ?? 'ro',
  };
  const T = MSG[request.lang];
  if (!(request.maxOdds > request.minOdds)) throw new Error(T.oddsOrder);
  const log: string[] = [];
  const say: Log = (l) => { log.push(l); onLog(l); };
  const needed = request.tickets * request.matches;
  // A single selection is already the final pick, so simple bets search every selection in
  // the range; capping at the likeliest few would leave the higher odds bands empty.
  const opts: BuilderOptions = {
    ...b, minLegs: betType === 'simple' ? 1 : b.minLegs, maxLegs: request.maxLegs, minOdds: request.minOdds, maxOdds: request.maxOdds,
    maxCandidateLegs: betType === 'simple' ? Number.MAX_SAFE_INTEGER : b.maxCandidateLegs,
  };
  const bandList = bands(request.minOdds, request.maxOdds);

  let fixtures = (await source.upcoming(request.windowHours)).filter((f) => bank.leagues.has(f.league));
  if (request.leagues.length) fixtures = fixtures.filter((f) => request.leagues.includes(f.league));
  say(T.upcoming(fixtures.length, request.windowHours, needed));

  const prepared: Prepared[] = [];
  for (const f of fixtures) {
    const p = prepare(bank, f, opts, bandList, request.lang);
    if (typeof p === 'string') logger.debug(p); else prepared.push(p);
  }
  say((betType === 'simple' ? T.withPick : T.withCombo)(prepared.length, request.minOdds, request.maxOdds));

  // Spread the builders over the odds bands; fall back to any band the match has.
  const pick = (p: Prepared, k: number): Builder => p.byBand[k % 3] ?? p.byBand.find(Boolean)!;
  const chosen: TicketMatch[] = [];
  const toMatch = (p: Prepared, bld: Builder, adjusted: number, extra: Partial<TicketMatch> = {}): TicketMatch => ({
    fixture: { id: p.f.id, league: p.f.league, leagueName: p.f.leagueName, country: p.f.country, home: p.f.home, away: p.f.away, kickoff: p.f.kickoff },
    legs: bld.legs, probability: bld.probability, adjusted, fairOdds: bld.fairOdds, ...extra,
  });

  if (!request.ai) {
    prepared.slice(0, needed).forEach((p, k) => { const bld = pick(p, k); chosen.push(toMatch(p, bld, bld.probability)); });
  } else {
    // AI only for matches about to be used, a few at a time, until the tickets are full.
    let next = 0;
    // Both counters move synchronously, so parallel workers can't race past them: `turn`
    // spreads attempts over the odds bands, `taken` reserves a ticket slot before the
    // (paid) explanation so no extra match is accepted.
    let turn = 0, taken = 0;
    const worker = async () => {
      while (chosen.length < needed && next < prepared.length) {
        const p = prepared[next++];
        const label = `${p.f.home} v ${p.f.away}`;
        const news: MatchNews | null = await getMatchNews({ eventId: p.f.id, home: p.f.home, away: p.f.away, competition: p.f.leagueName, kickoff: p.f.kickoff });
        const state: MatchState = {
          eventId: p.f.id, match: label, competition: `${p.f.country} - ${p.f.leagueName}`, kickoff: p.f.kickoff, news,
          form: { home: news?.home.recentForm ?? 'unknown', away: news?.away.recentForm ?? 'unknown' }, market: marketLabels(p.f),
        };
        const verdict = await filterMatch(state);
        if (!verdict.keep) { say(T.skipped(label, verdict.reasons.map((r) => reason(request.lang, r)).join('; '))); continue; }
        const bld = pick(p, turn++);
        const check = await checkBuilder(state, bld.legs, bld.probability);
        if (!check.ok) { say(T.skipped(label, T.notFit)); continue; }
        if (taken >= needed) return;
        taken++;
        const explanation = await explainBuilder({ match: label, news, legs: bld.legs, probability: bld.probability, lang: request.lang });
        chosen.push(toMatch(p, bld, bld.probability * verdict.weight, {
          explanation, jev: { risk: verdict.flags.riskHigh, infoLow: verdict.flags.infoLow, consistency: check.consistency },
        }));
        say(T.added(label, bld.legs.map((l) => `${l.market} ${l.pick}`).join(' + '), bld.fairOdds.toFixed(2), chosen.length, needed));
      }
    };
    try {
      await Promise.all(Array.from({ length: settings.ai.parallel }, worker));
    } catch (e) {
      if (e instanceof FatalPipelineError) throw e;
      throw e;
    }
  }

  const tickets: Ticket[] = Array.from({ length: request.tickets }, (_, i) => ({ index: i + 1, matches: [] as TicketMatch[], probability: 1, fairOdds: 1 }));
  chosen.slice(0, needed).forEach((m, k) => tickets[k % request.tickets].matches.push(m));
  for (const tk of tickets) {
    tk.probability = tk.matches.reduce((a, m) => a * m.adjusted, 1);
    tk.fairOdds = tk.matches.reduce((a, m) => a * m.fairOdds, 1);
  }
  const result = tickets.filter((tk) => tk.matches.length);
  say(T.done(result.length, chosen.length, needed));
  return { createdAt: new Date().toISOString(), request, tickets: result, found: chosen.length, needed, aiUsed: request.ai, log };
}
