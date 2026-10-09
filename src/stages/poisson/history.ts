import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import { paths } from '../../config/config';
import { logger } from '../../utils/logger';
import { LeagueDef } from './leagues';

/** The per-match stat lines the count models are trained on. Values are [home, away]. */
export type StatKey = 'shots' | 'sot' | 'corners' | 'cards' | 'reds';
export const STAT_KEYS: StatKey[] = ['shots', 'sot', 'corners', 'cards', 'reds'];

export interface MatchRecord {
  league: string;
  date: string;            // YYYY-MM-DD
  home: string;
  away: string;
  hg: number;
  ag: number;
  hthg?: number;
  htag?: number;
  stats: Partial<Record<StatKey, [number, number]>>;
}

const BASE = 'https://www.football-data.co.uk';
const CURRENT_TTL_MS = 12 * 3600_000;

/** "2627" for the season containing `d`; European seasons turn over in July. */
export function seasonCode(d: Date): string {
  const y = d.getUTCFullYear() % 100;
  const start = d.getUTCMonth() >= 6 ? y : (y + 99) % 100;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(start)}${pad((start + 1) % 100)}`;
}

function previousSeason(code: string): string {
  const a = (Number(code.slice(0, 2)) + 99) % 100;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(a)}${pad((a + 1) % 100)}`;
}

/** dd/mm/yy or dd/mm/yyyy -> YYYY-MM-DD */
export function parseDate(s: string): string | null {
  const m = s.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!m) return null;
  const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  return `${year}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

const num = (v: string | undefined): number | undefined => {
  if (v == null || v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** Parse one football-data.co.uk CSV. Both file families are handled by column name. */
export function parseCsv(text: string, league: string): MatchRecord[] {
  const lines = text.replace(/^ï»¿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const head = lines[0].split(',').map((h) => h.trim());
  const idx = new Map(head.map((h, i) => [h, i]));
  const out: MatchRecord[] = [];

  for (const line of lines.slice(1)) {
    const c = line.split(',');
    const get = (...names: string[]) => {
      for (const n of names) {
        const i = idx.get(n);
        if (i != null && c[i] != null && c[i].trim() !== '') return c[i];
      }
      return undefined;
    };
    const date = parseDate(get('Date') ?? '');
    const home = get('HomeTeam', 'Home')?.trim();
    const away = get('AwayTeam', 'Away')?.trim();
    const hg = num(get('FTHG', 'HG'));
    const ag = num(get('FTAG', 'AG'));
    if (!date || !home || !away || hg == null || ag == null) continue;

    const pair = (h: string, a: string): [number, number] | undefined => {
      const x = num(get(h)), y = num(get(a));
      return x != null && y != null ? [x, y] : undefined;
    };
    const stats: MatchRecord['stats'] = {};
    const shots = pair('HS', 'AS'); if (shots) stats.shots = shots;
    const sot = pair('HST', 'AST'); if (sot) stats.sot = sot;
    const corners = pair('HC', 'AC'); if (corners) stats.corners = corners;
    const yellow = pair('HY', 'AY');
    const reds = pair('HR', 'AR');
    if (reds) stats.reds = reds;
    // "Cards" counts every card shown, so a red is one more card on top of the yellows.
    if (yellow && reds) stats.cards = [yellow[0] + reds[0], yellow[1] + reds[1]];

    out.push({
      league, date, home, away, hg, ag,
      hthg: num(get('HTHG')), htag: num(get('HTAG')),
      stats,
    });
  }
  return out;
}

async function cachedDownload(url: string, file: string, ttlMs: number | null): Promise<string | null> {
  const full = path.join(paths.history, file);
  if (fs.existsSync(full)) {
    const age = Date.now() - fs.statSync(full).mtimeMs;
    if (ttlMs == null || age < ttlMs) return fs.readFileSync(full, 'utf8');
  }
  try {
    const res = await axios.get<string>(url, { timeout: 60_000, responseType: 'text', validateStatus: () => true });
    if (res.status !== 200 || typeof res.data !== 'string' || !res.data.includes(',')) {
      logger.warn(`history ${url}: HTTP ${res.status}`);
      return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null;
    }
    fs.writeFileSync(full, res.data);
    return res.data;
  } catch (err: any) {
    logger.warn(`history ${url} failed: ${err.message}`);
    return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null;
  }
}

/**
 * Results for one league over the last `seasons` seasons, oldest first. The current season
 * is re-downloaded every 12h; finished seasons are fetched once and kept.
 */
export async function loadLeagueHistory(league: LeagueDef, seasons: number, now = new Date()): Promise<MatchRecord[]> {
  let records: MatchRecord[] = [];
  if (league.kind === 'main') {
    let code = seasonCode(now);
    for (let i = 0; i < seasons; i++) {
      const text = await cachedDownload(`${BASE}/mmz4281/${code}/${league.code}.csv`, `${league.code}_${code}.csv`, i === 0 ? CURRENT_TTL_MS : null);
      if (text) records.push(...parseCsv(text, league.code));
      code = previousSeason(code);
    }
  } else {
    const text = await cachedDownload(`${BASE}/new/${league.code}.csv`, `${league.code}.csv`, CURRENT_TTL_MS);
    const cutoff = new Date(now.getTime() - seasons * 365 * 86400_000).toISOString().slice(0, 10);
    if (text) records = parseCsv(text, league.code).filter((r) => r.date >= cutoff);
  }
  return records.sort((a, b) => a.date.localeCompare(b.date));
}

/** Days between the newest result and `now`: football-data.co.uk lags by up to ~2 weeks. */
export function staleDays(records: MatchRecord[], now = new Date()): number {
  if (!records.length) return Infinity;
  const last = records[records.length - 1].date;
  return Math.floor((now.getTime() - Date.parse(`${last}T00:00:00Z`)) / 86400_000);
}
