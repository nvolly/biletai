import * as fs from 'fs';
import * as path from 'path';
import { paths } from '../config/config';
import { logger } from '../utils/logger';
import { ModelBank } from '../stages/poisson/modelBank';
import { MatchRecord, StatKey } from '../stages/poisson/history';
import { Simulation } from '../stages/poisson/simulate';
import { catalogue } from './catalogue';
import type { GenerationResult, Ticket, TicketMatch } from './generate';

/**
 * The results tracker: settles every pick BiletAI generated against the real result, and
 * keeps an honest track record (how often "70-80%" picks actually came in).
 *
 * A played match is turned into a one-run "simulation", so each pick is settled by the very
 * test that priced it in the catalogue: no second implementation of the markets to drift.
 * Results come from the same football-data.co.uk files as the training data (~2 weeks late).
 */
export interface MatchResult {
  score: string;               // "2-1"
  won: boolean | null;         // null: a selection could not be settled from the data
  legs: (boolean | null)[];
  settledAt: string;
}

const one = (x: number) => Int16Array.of(x);

/** One played match as a single simulated run. */
export function asOutcome(r: MatchRecord): Simulation {
  const counts: Simulation['counts'] = {};
  for (const [k, v] of Object.entries(r.stats) as [StatKey, [number, number]][]) counts[k] = [one(v[0]), one(v[1])];
  return { n: 1, seed: 0, gh: one(r.hg), ga: one(r.ag), gh1: one(r.hthg ?? 0), ga1: one(r.htag ?? 0), counts };
}

const needsHalves = (id: string) => /^(goals\.h[12]|ht)\./.test(id);

export function settleMatch(m: Pick<TicketMatch, 'fixture' | 'legs'>, r: MatchRecord): MatchResult {
  const sim = asOutcome(r);
  const byId = new Map(catalogue(m.fixture.home, m.fixture.away).map((s) => [s.id, s]));
  const legs = m.legs.map((l) => {
    const s = byId.get(l.id);
    if (!s) return null;
    if (needsHalves(s.id) && (r.hthg == null || r.htag == null)) return null;
    if (s.needs.some((n) => n !== 'goals' && !r.stats[n])) return null;
    return s.test(sim, 0);
  });
  const won = legs.includes(false) ? false : legs.every((x) => x === true) ? true : null;
  return { score: `${r.hg}-${r.ag}`, won, legs, settledAt: new Date().toISOString() };
}

/** The played match for a fixture: same teams, same day (±1 for UK vs UTC dates). */
export function findRecord(records: MatchRecord[], m: Pick<TicketMatch, 'fixture'>): MatchRecord | undefined {
  const day = Date.parse(m.fixture.kickoff.slice(0, 10));
  return records.find((r) => r.home === m.fixture.home && r.away === m.fixture.away && Math.abs(Date.parse(r.date) - day) <= 86400_000);
}

export function ticketStatus(tk: Ticket): Ticket['status'] {
  if (tk.matches.some((m) => m.result?.won === false)) return 'lost';
  if (tk.matches.every((m) => m.result?.won === true)) return 'won';
  return undefined;
}

/** Settle what can be settled in one generation; true if anything changed. */
export function settleGeneration(g: GenerationResult, lookup: (m: TicketMatch) => MatchRecord | undefined, now = Date.now()): boolean {
  let changed = false;
  for (const tk of g.tickets) {
    for (const m of tk.matches) {
      if (m.result || Date.parse(m.fixture.kickoff) + 3 * 3600_000 > now) continue;
      const r = lookup(m);
      if (!r) continue;
      m.result = settleMatch(m, r);
      changed = true;
    }
    const status = ticketStatus(tk);
    if (status !== tk.status) { tk.status = status; changed = true; }
  }
  return changed;
}

interface Bucket { from: number; to: number; n: number; predicted: number; won: number }

/**
 * The calibration table: for each probability bucket, how often picks in it actually won
 * (`actual`) versus the probability shown to the user (`predicted`), and how many picks it
 * contains (`n`). These are exactly the settle buckets below, so the app's "Rezultate reale"
 * and the backtest report judge the same ranges.
 */
export interface CalibrationRow {
  from: number;
  to: number;
  label: string;      // "50–60%"
  n: number;
  predicted: number;  // mean shown probability of picks in the bucket
  actual: number;      // win rate of picks in the bucket (won / n), 0 when n = 0
}

/** The bucket edges the whole project shares: a pick with shown probability p lands in
 *  the bucket whose from <= p < to. Edges above 1 (1.0001) cap the top bucket at 1. */
export const CALIBRATION_EDGES = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0001];

/** The index into `CALIBRATION_EDGES` of the bucket containing p, or -1 outside the ranges. */
export function bucketIndexFor(p: number): number {
  for (let i = 0; i < CALIBRATION_EDGES.length - 1; i++) {
    if (p >= CALIBRATION_EDGES[i] && p < CALIBRATION_EDGES[i + 1]) return i;
  }
  return -1;
}

/**
 * A bucket being filled with running totals (count, sum of shown probabilities, wins);
 * `finishCalibration` turns it into the reported `CalibrationRow`.
 */
export interface CalibrationAccum { from: number; to: number; label: string; n: number; sumP: number; won: number }

/** Fresh, zeroed buckets, in the same order and labels `formatCalibration` prints them under. */
export function makeCalibrationBuckets(): CalibrationAccum[] {
  return CALIBRATION_EDGES.slice(0, -1).map((from, i) => {
    const to = Math.min(1, CALIBRATION_EDGES[i + 1]);
    return { from, to, label: `${Math.round(from * 100)}–${Math.round(to * 100)}%`, n: 0, sumP: 0, won: 0 };
  });
}

/** Add one settled pick (shown probability p, did it win) to its running bucket, if it has one. */
export function addCalibration(accum: CalibrationAccum[] | null | undefined, p: number, won: boolean): void {
  const b = accum?.[bucketIndexFor(p)];
  if (!b) return;
  b.n++;
  b.sumP += p;
  if (won) b.won++;
}

/** Turn filled bucket accumulators into the reported calibration table. */
export function finishCalibration(accum: CalibrationAccum[]): CalibrationRow[] {
  return accum.map((r) => ({
    from: r.from, to: r.to, label: r.label, n: r.n,
    predicted: r.n ? r.sumP / r.n : 0,
    actual: r.n ? r.won / r.n : 0,
  }));
}

/** The calibration table as text, e.g. shown under the backtest totals. */
export function formatCalibration(rows: CalibrationRow[]): string {
  let out = 'calibration (predicted vs actual, by shown probability bucket)\n';
  for (const r of rows) {
    out += `  ${r.label.padEnd(8)} n=${String(r.n).padStart(4)}  predicted=${(r.predicted * 100).toFixed(0).padStart(3)}%  actual=${(r.actual * 100).toFixed(0).padStart(3)}%\n`;
  }
  return out;
}

export interface TrackRecord {
  updatedAt: string;
  matches: { n: number; won: number; predicted: number };          // predicted = mean shown probability
  buckets: Bucket[];
  calibration: CalibrationRow[];                                   // predicted vs actual hit rate per bucket
  byType: Record<'simple' | 'combo', { n: number; won: number; predicted: number }>;
  tickets: { n: number; won: number; predicted: number };
}

const generationFiles = () => {
  const root = path.join(paths.data, 'generations');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).flatMap((u) => fs.readdirSync(path.join(root, u)).filter((f) => f.endsWith('.json')).map((f) => path.join(root, u, f)));
};

/**
 * Aggregate every settled pick. The probability judged is the one the app showed
 * (`adjusted`, after Jev). The same pick on many users' tickets counts once.
 */
export function trackRecord(gens: GenerationResult[]): TrackRecord {
  const edges = CALIBRATION_EDGES;
  const buckets: Bucket[] = edges.slice(0, -1).map((from, i) => ({ from, to: Math.min(1, edges[i + 1]), n: 0, predicted: 0, won: 0 }));
  const calibration = makeCalibrationBuckets();
  const all = { n: 0, won: 0, predicted: 0 };
  const byType = { simple: { n: 0, won: 0, predicted: 0 }, combo: { n: 0, won: 0, predicted: 0 } };
  const tickets = { n: 0, won: 0, predicted: 0 };
  const seen = new Set<string>();
  const add = (s: { n: number; won: number; predicted: number }, p: number, won: boolean) => { s.n++; s.predicted += p; if (won) s.won++; };
  for (const g of gens) {
    const type = g.request.betType === 'simple' ? 'simple' : 'combo';
    for (const tk of g.tickets) {
      if (tk.status) add(tickets, tk.probability, tk.status === 'won');
      for (const m of tk.matches) {
        if (m.result?.won == null) continue;
        const key = `${m.fixture.id}|${m.legs.map((l) => l.id).sort().join('+')}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const p = m.adjusted;
        add(all, p, m.result.won);
        add(byType[type], p, m.result.won);
        const b = buckets.find((x) => p >= x.from && p < x.to);
        if (b) add(b, p, m.result.won);
        addCalibration(calibration, p, m.result.won);
      }
    }
  }
  const mean = <T extends { n: number; predicted: number }>(s: T) => ({ ...s, predicted: s.n ? s.predicted / s.n : 0 });
  return {
    updatedAt: new Date().toISOString(),
    matches: mean(all), buckets: buckets.map(mean), calibration: finishCalibration(calibration),
    byType: { simple: mean(byType.simple), combo: mean(byType.combo) }, tickets: mean(tickets),
  };
}

export const TRACK_FILE = () => path.join(paths.data, 'track-record.json');

/** Settle every stored generation against the bank's results, then rebuild the track record. */
export function settleAll(bank: ModelBank): TrackRecord {
  const gens: GenerationResult[] = [];
  let settled = 0;
  for (const file of generationFiles()) {
    try {
      const g = JSON.parse(fs.readFileSync(file, 'utf8')) as GenerationResult;
      const lookup = (m: TicketMatch) => { const lm = bank.leagues.get(m.fixture.league); return lm ? findRecord(lm.records, m) : undefined; };
      if (settleGeneration(g, lookup)) { fs.writeFileSync(file, JSON.stringify(g)); settled++; }
      gens.push(g);
    } catch (e: any) {
      logger.warn(`settle ${file}: ${e?.message ?? e}`);
    }
  }
  const tr = trackRecord(gens);
  fs.writeFileSync(TRACK_FILE(), JSON.stringify(tr));
  logger.info(`results tracker: ${settled} generation(s) updated, ${tr.matches.n} settled pick(s)`);
  return tr;
}
