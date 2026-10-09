import axios from 'axios';
import { createHash } from 'crypto';
import { readCache, writeCache } from '../data/cache';
import { logger } from '../utils/logger';
import { parseDate } from '../stages/poisson/history';
import { LEAGUES, leagueByCode, leagueForFeed } from '../stages/poisson/leagues';

/**
 * Upcoming matches. The prototype reads football-data.co.uk's two fixture feeds — the same
 * source as the training history, so team names match the models exactly. They carry
 * average market prices for 1X2 (and Over/Under 2.5 in the main leagues), used to blend
 * the model's expected goals with the market.
 *
 * Before charging customers: confirm the provider's commercial-use terms, or swap in a
 * licensed feed behind `FixtureSource`.
 */
export interface Fixture {
  id: string;
  league: string;        // model code, e.g. "E0"
  leagueName: string;
  country: string;
  home: string;
  away: string;
  kickoff: string;       // ISO, UTC
  market: { home?: number; draw?: number; away?: number; over25?: number; under25?: number };
}

export interface FixtureSource { upcoming(windowHours: number, now?: Date): Promise<Fixture[]> }

const MAIN = 'https://www.football-data.co.uk/fixtures.csv';
const EXTRA = 'https://www.football-data.co.uk/new_league_fixtures.csv';

/** football-data kick-off times are UK local time; convert to UTC whatever the season. */
export function ukToUtc(dateIso: string, time: string): Date {
  const [h, m] = (time || '15:00').split(':').map(Number);
  const guess = new Date(`${dateIso}T${String(h).padStart(2, '0')}:${String(m || 0).padStart(2, '0')}:00Z`);
  const london = new Date(guess.toLocaleString('en-US', { timeZone: 'Europe/London' }));
  const utc = new Date(guess.toLocaleString('en-US', { timeZone: 'UTC' }));
  return new Date(guess.getTime() - (london.getTime() - utc.getTime()));
}

function rows(text: string): Record<string, string>[] {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const head = lines[0].split(',').map((h) => h.trim());
  return lines.slice(1).map((l) => {
    const c = l.split(',');
    return Object.fromEntries(head.map((h, i) => [h, (c[i] ?? '').trim()]));
  });
}

const num = (v?: string) => (v && Number.isFinite(Number(v)) && Number(v) > 1 ? Number(v) : undefined);

async function fetchText(url: string): Promise<string> {
  const key = `feed_${createHash('sha1').update(url).digest('hex').slice(0, 8)}`;
  const cached = readCache<string>(key);
  if (cached) return cached;
  const res = await axios.get<string>(url, { timeout: 30_000, responseType: 'text', validateStatus: () => true });
  if (res.status !== 200) { logger.warn(`fixtures ${url}: HTTP ${res.status}`); return ''; }
  writeCache(key, res.data, 60 * 60_000);
  return res.data;
}

export const footballDataFixtures: FixtureSource = {
  async upcoming(windowHours, now = new Date()) {
    const out: Fixture[] = [];
    const push = (league: string | undefined, date: string, time: string, home: string, away: string, market: Fixture['market']) => {
      const def = league ? leagueByCode(league) : undefined;
      const iso = parseDate(date);
      if (!def || !iso || !home || !away) return;
      const kickoff = ukToUtc(iso, time);
      if (kickoff.getTime() <= now.getTime() || kickoff.getTime() > now.getTime() + windowHours * 3600_000) return;
      const id = createHash('sha1').update(`${def.code}|${iso}|${home}|${away}`).digest('hex').slice(0, 12);
      out.push({ id, league: def.code, leagueName: def.name, country: def.country, home, away, kickoff: kickoff.toISOString(), market });
    };
    for (const r of rows(await fetchText(MAIN))) {
      push(r.Div, r.Date, r.Time, r.HomeTeam, r.AwayTeam, {
        home: num(r.AvgH), draw: num(r.AvgD), away: num(r.AvgA), over25: num(r['Avg>2.5']), under25: num(r['Avg<2.5']),
      });
    }
    for (const r of rows(await fetchText(EXTRA))) {
      push(leagueForFeed(r.Country ?? '', r.League ?? '')?.code, r.Date, r.Time, r.Home, r.Away, {
        home: num(r.AvgH), draw: num(r.AvgD), away: num(r.AvgA),
      });
    }
    // Most important leagues first (the order of LEAGUES), then by kick-off.
    const order = new Map(LEAGUES.map((l, i) => [l.code, i]));
    return out.sort((a, b) => order.get(a.league)! - order.get(b.league)! || a.kickoff.localeCompare(b.kickoff));
  },
};
