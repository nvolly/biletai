import { z } from 'zod';
import { readCache } from '../../data/cache';
import { logger } from '../../utils/logger';
import { settings } from '../../config/config';
import type { GenerationResult } from '../../engine/generate';
import type { LeagueDef } from '../poisson/leagues';
import { createMessage, Message } from './deepseek';
import { FatalPipelineError, isAccountError, MatchNews, newsModel, structured } from './newsAgent';

/**
 * The two conversational helpers, both server-side (the keys never leave the server):
 *   - parseRequest: "3 meciuri din Premier League, cote mici, sâmbătă" -> the form's settings;
 *   - askAboutTicket: questions about ONE generated ticket, answered only from that ticket's
 *     numbers and the team news already gathered for it.
 */
export const WINDOWS = [24, 48, 72, 144];

const RequestSchema = z.object({
  understood: z.boolean().describe('false if this is not a request for football tickets'),
  betType: z.enum(['simple', 'combo']).nullable().describe('simple = one selection per match; combo = 2-4 selections on the same match; null if not said'),
  tickets: z.number().int().nullable(),
  matches: z.number().int().nullable().describe('matches per ticket'),
  minOdds: z.number().nullable().describe('lowest fair odds per match'),
  maxOdds: z.number().nullable().describe('highest fair odds per match'),
  maxLegs: z.number().int().nullable().describe('combo only: most selections per match (2-5)'),
  hours: z.number().nullable().describe('how many hours from now the matches must kick off within'),
  leagues: z.array(z.string()).describe('league codes from the list; empty = all'),
});

export interface ParsedRequest {
  betType?: 'simple' | 'combo'; tickets?: number; matches?: number; minOdds?: number; maxOdds?: number;
  maxLegs?: number; windowHours?: number; leagues: string[];
}

const clamp = (x: number | null, lo: number, hi: number) => (x == null || !Number.isFinite(x) ? undefined : Math.min(hi, Math.max(lo, x)));

/** Validate and clamp the model's reading of a request, so it can only produce valid settings. */
export function cleanRequest(raw: z.infer<typeof RequestSchema>, leagues: LeagueDef[]): ParsedRequest | null {
  if (!raw.understood) return null;
  const t = settings.tickets;
  const known = new Set(leagues.map((l) => l.code));
  let minOdds = clamp(raw.minOdds, 1.05, 10), maxOdds = clamp(raw.maxOdds, 1.1, 20);
  if (minOdds != null && maxOdds != null && !(maxOdds > minOdds)) { minOdds = undefined; maxOdds = undefined; }
  const hours = clamp(raw.hours, 1, 240);
  return {
    betType: raw.betType ?? undefined,
    tickets: clamp(raw.tickets, 1, t.maxTickets),
    matches: clamp(raw.matches, 1, t.maxMatches),
    minOdds, maxOdds,
    maxLegs: clamp(raw.maxLegs, 2, 5),
    // The app offers fixed windows: the smallest one that covers the request.
    windowHours: hours == null ? undefined : WINDOWS.find((w) => w >= hours) ?? WINDOWS[WINDOWS.length - 1],
    leagues: [...new Set(raw.leagues.filter((c) => known.has(c)))],
  };
}

export async function parseRequest(text: string, leagues: LeagueDef[], now = new Date()): Promise<ParsedRequest | null> {
  const list = leagues.map((l) => `${l.code}: ${l.country} ${l.name}`).join('\n');
  try {
    const raw = await structured(RequestSchema,
      `A user of a football statistics app describes, in Romanian or English, the tickets they want. Turn it into settings.\n` +
      `Now: ${now.toISOString()} (${now.toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'Europe/Bucharest' })} in Romania).\n` +
      `Guidance: "cote mici"/"low odds" ~ 1.20-1.50 per match; "cote medii" ~ 1.50-2.00; "cote mari"/"high odds" ~ 2.00-3.50. ` +
      `"un singur pariu pe meci"/"simplu"/"single" = simple; "combinat"/"mai multe selecții pe meci"/"combo" = combo. ` +
      `For a day ("sâmbătă", "weekend", "mâine") give the hours from now to the END of that day. Leave anything not mentioned as null.\n` +
      `Leagues (code: country name):\n${list}\n\nUser request: """${text}"""`,
      600);
    return raw ? cleanRequest(raw, leagues) : null;
  } catch (err: any) {
    if (isAccountError(err)) throw new FatalPipelineError(`DeepSeek API unusable: ${err.message}`);
    logger.warn(`parse request failed: ${err?.message ?? err}`);
    return null;
  }
}

export interface ChatTurn { q: string; a: string; at: string }

/** The facts the assistant may use: the ticket's numbers, results, explanations, news. */
export function ticketContext(g: GenerationResult): string {
  const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
  return g.tickets.map((tk) => [
    `TICKET ${tk.index} (${g.request.betType === 'simple' ? 'one selection per match' : 'combination per match'}): ` +
      `total fair odds ${tk.fairOdds.toFixed(2)}, chance ${pct(tk.probability)}${tk.status ? `, result: ${tk.status}` : ''}`,
    ...tk.matches.map((m, i) => {
      const news = readCache<MatchNews>(`news_${m.fixture.id}`);
      return [
        `  Match ${i + 1}: ${m.fixture.home} vs ${m.fixture.away} (${m.fixture.leagueName}, ${m.fixture.country}), kickoff ${m.fixture.kickoff} UTC`,
        `    selections: ${m.legs.map((l) => `${l.market}: ${l.pick} (${pct(l.probability)} alone)`).join('; ')}`,
        `    all selections together: model ${pct(m.probability)}, after the risk check ${pct(m.adjusted)}, fair odds ${m.fairOdds.toFixed(2)}`,
        m.jev ? `    risk check: high-risk ${pct(m.jev.risk)}, low information ${pct(m.jev.infoLow)}` : '',
        m.result ? `    played: ${m.result.score}, selections ${m.result.won === true ? 'came in' : m.result.won === false ? 'did not come in' : 'not settled'}` : '',
        m.explanation ? `    explanation shown: ${m.explanation}` : '',
        news ? `    team news: ${JSON.stringify({ home: news.home, away: news.away, context: news.context, motivation: news.motivation, infoGaps: news.infoGaps })}` : '    team news: not available',
      ].filter(Boolean).join('\n');
    }),
  ].join('\n')).join('\n\n');
}

export async function askAboutTicket(g: GenerationResult, chat: ChatTurn[], question: string, lang: 'ro' | 'en'): Promise<string> {
  const language = lang === 'ro' ? 'Romanian, with correct diacritics' : 'English';
  const rules =
    `You are BiletAI's analyst. Answer questions about the football ticket below, in ${language}, plainly, in at most 120 words, as plain text without markdown.\n` +
    `Rules (always):\n` +
    `- Use ONLY the facts below: the model's numbers, the risk check, the explanations and the team news. If something isn't there, say you don't know.\n` +
    `- The facts are labelled in English; write everything in ${language}, labels included` +
    (lang === 'ro' ? ` (e.g. "high-risk" = "risc ridicat", "low information" = "informații puține", "risk check" = "verificarea riscului").\n` : '.\n') +
    `- Never promise or imply a result: no "sigur", "garantat", "sure", "lock". Probabilities are estimates; any match can go either way.\n` +
    `- Never name, recommend or compare bookmakers or say where to bet. Never advise how much to stake; if asked, say BiletAI doesn't give stake advice and to play only what they can afford to lose.\n` +
    `- Only if the user explicitly asks to change, replace or remove something on the ticket: say you can't edit it and that a new generation picks different matches. Never say this otherwise.\n` +
    `- If the question isn't about this ticket or football, politely say you can only discuss this ticket.\n\n` +
    `<ticket>\n${ticketContext(g)}\n</ticket>`;
  const messages: Message[] = [];
  chat.forEach((turn, i) => {
    messages.push({ role: 'user', content: i === 0 ? `${rules}\n\nQuestion: ${turn.q}` : turn.q }, { role: 'assistant', content: turn.a });
  });
  messages.push({ role: 'user', content: chat.length ? question : `${rules}\n\nQuestion: ${question}` });
  try {
    const res = await createMessage({ model: newsModel(), max_tokens: 700, messages, thinking: { type: 'disabled' } });
    return res.content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim();
  } catch (err: any) {
    if (isAccountError(err)) throw new FatalPipelineError(`DeepSeek API unusable: ${err.message}`);
    throw err;
  }
}
