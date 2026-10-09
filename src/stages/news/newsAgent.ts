import { z } from 'zod';
import { env, settings } from '../../config/config';
import { readCache, writeCache } from '../../data/cache';
import { logger } from '../../utils/logger';
import { createMessage, DeepSeekError, Message } from './deepseek';

/**
 * Stage 3: team news for one match, researched with DeepSeek's server-side web search and
 * condensed into a fixed structure that becomes part of the Jev state in Stage 2.
 *
 * Two calls rather than one: the first researches (web search, at most
 * `news.maxSearches` queries), the second turns the research notes into the schema. Keeping
 * the search call free of an output format leaves the model room to cite and reason over
 * results; the format call then cannot invent beyond the notes it is handed. Results are
 * cached per match for `news.cacheHours`.
 */
const TeamNews = z.object({
  injured: z.array(z.string()).describe('Players ruled out injured'),
  suspended: z.array(z.string()).describe('Players suspended for this match'),
  doubtful: z.array(z.string()).describe('Players whose availability is uncertain'),
  expectedLineup: z.array(z.string()).describe('Players expected to start, surnames as commonly written; empty if unknown'),
  lineupChanges: z.string().describe('Expected rotation or tactical changes, or "none reported"'),
  keyPlayersOut: z.array(z.string()).describe('Of the absentees, the ones who normally start and matter most'),
  recentForm: z.string().describe('One sentence on recent results'),
});

export const MatchNewsSchema = z.object({
  home: TeamNews,
  away: TeamNews,
  context: z.string().describe('Competition situation: title race, relegation, derby, European week, cup rotation, etc.'),
  motivation: z.string().describe('Which side has more to play for, and why; "balanced" if neither'),
  infoGaps: z.string().describe('What could not be confirmed (e.g. lineups not yet announced)'),
});
export type MatchNews = z.infer<typeof MatchNewsSchema> & { sources: string[] };

export interface NewsRequest {
  eventId: string;
  home: string;
  away: string;
  competition: string;
  kickoff: string;
}

const newsModel = () => env.NEWS_MODEL ?? 'deepseek-flash';

/**
 * A schema-checked JSON answer, or null when it cannot be produced. DeepSeek has no
 * structured-output mode, so the schema goes in the prompt and the reply is validated.
 */
async function structured<T extends z.ZodType>(schema: T, prompt: string, maxTokens: number): Promise<z.infer<T> | null> {
  const jsonPrompt = `${prompt}\n\nReply with ONLY a JSON object, no prose and no code fences, matching this JSON Schema:\n` +
    JSON.stringify(z.toJSONSchema(schema));
  const messages: Message[] = [{ role: 'user', content: jsonPrompt }];
  // One retry with the validation error: cheap, and it fixes most malformed answers.
  for (let attempt = 0; attempt < 2; attempt++) {
    // Thinking off: this is copying notes into a schema. With it on, deepseek-flash spent
    // ~3,200 of 4,000 tokens thinking (2026-10-07) and on longer notes returned no text at all.
    const res = await createMessage({
      model: newsModel(), max_tokens: maxTokens, messages, thinking: { type: 'disabled' },
    });
    const text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim()
      .replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    let error: string;
    try {
      const parsed = schema.safeParse(JSON.parse(text));
      if (parsed.success) return parsed.data;
      error = parsed.error.message;
    } catch (e: any) {
      error = `not valid JSON: ${e.message}`;
    }
    messages.push({ role: 'assistant', content: text || '(empty)' },
      { role: 'user', content: `That reply was rejected (${error}). Reply again with ONLY the corrected JSON object.` });
    if (attempt === 1) logger.warn(`DeepSeek gave no valid JSON after a retry: ${error.slice(0, 300)}`);
  }
  return null;
}

async function research(req: NewsRequest): Promise<{ notes: string; urls: string[] }> {
  const user = `Research team news for ${req.home} vs ${req.away} (${req.competition}), kicking off ${req.kickoff} UTC.\n` +
    `Find: injuries, suspensions, doubts, the expected starting XI for each side, likely rotation (e.g. a European ` +
    `fixture midweek), and what is at stake for each team. Prefer sources from the last 7 days. ` +
    `Report only what the sources say; say plainly when something could not be found.`;
  const messages: Message[] = [{ role: 'user', content: user }];
  const tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: settings.news.maxSearches }];

  let text = '';
  const urls = new Set<string>();
  // The server pauses long search loops with stop_reason "pause_turn"; resuming means
  // sending the paused turn back unchanged.
  for (let turn = 0; turn < 4; turn++) {
    // Thinking off: same web search, about half the tokens (2026-10-07 probe: 3,431 vs
    // 7,258 input and 94 vs 209 output tokens for one search).
    const res = await createMessage({ model: newsModel(), max_tokens: 4000, messages, tools, thinking: { type: 'disabled' } });
    for (const b of res.content) {
      if (b.type === 'text') text += b.text ?? '';
      // A failed search returns an error object here, not a list.
      if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) for (const r of b.content) if (r?.url) urls.add(r.url);
    }
    if (res.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: res.content });
  }
  return { notes: text.trim(), urls: [...urls] };
}

async function structure(req: NewsRequest, notes: string): Promise<MatchNews | null> {
  // `sources` is filled from the search results themselves, not by the model.
  const parsed = await structured(MatchNewsSchema,
    `Fill the schema for ${req.home} (home) vs ${req.away} (away) using ONLY these research notes. ` +
    `Use empty lists where the notes are silent; do not add players the notes do not mention.\n\n<notes>\n${notes || '(no notes)'}\n</notes>`,
    4000);
  return parsed ? { ...parsed, sources: [] } : null;
}

export async function getMatchNews(req: NewsRequest): Promise<MatchNews | null> {
  const key = `news_${req.eventId}`;
  const cached = readCache<MatchNews>(key);
  if (cached) return cached;
  try {
    const { notes, urls } = await research(req);
    const news = await structure(req, notes);
    if (!news) logger.warn(`news for ${req.home} v ${req.away}: no usable summary (${notes.length} chars of research)`);
    if (news) {
      news.sources = urls;
      writeCache(key, news, settings.news.cacheHours * 3600_000);
    }
    return news;
  } catch (err: any) {
    if (isAccountError(err)) throw new FatalPipelineError(`DeepSeek API unusable: ${err.message}`);
    logger.warn(`news for ${req.home} v ${req.away} failed: ${err?.message ?? String(err)}`);
    return null;
  }
}

/** Raised when continuing would only produce silently degraded results. */
export class FatalPipelineError extends Error {}

/**
 * Billing and auth failures are not per-match problems: every later call fails the same way,
 * and Jev then drops each match as "no information" (2026-10-05: 189 of 276 matches lost to
 * an exhausted credit balance before anyone noticed). Stop the run instead.
 */
function isAccountError(err: any): boolean {
  if (!(err instanceof DeepSeekError)) return false;
  // 401/403: bad key; 402: DeepSeek's "Insufficient Balance".
  if ([401, 402, 403].includes(err.status)) return true;
  return err.status === 400 && /insufficient balance/i.test(err.message);
}

const ExplanationSchema = z.object({ summary: z.string() });

/**
 * Two or three plain-language sentences on why a builder makes sense, grounded only in the
 * model's numbers and the news. One call per match that ends up on a ticket.
 */
export async function explainBuilder(input: {
  match: string;
  news: MatchNews | null;
  legs: { market: string; pick: string; probability: number }[];
  probability: number;
  lang: 'ro' | 'en';
}): Promise<string> {
  // Shown to the user as written, in the language they chose in the app.
  const language = input.lang === 'ro' ? 'ROMANIAN (natural, simple, with correct diacritics)' : 'ENGLISH (natural and simple)';
  try {
    const parsed = await structured(ExplanationSchema,
      `Football match: ${input.match}. A statistical model suggests this combination of selections ` +
        `(market names are ${input.lang === 'ro' ? 'Romanian' : 'English'}), which all have to happen together ` +
        `(model probability ${(input.probability * 100).toFixed(1)}%):\n` +
        input.legs.map((l) => `- ${l.market}: ${l.pick} (${(l.probability * 100).toFixed(0)}% on its own)`).join('\n') +
        `\n\nTeam news: ${input.news ? JSON.stringify(input.news) : 'unavailable'}\n\n` +
        `Write 2-3 sentences IN ${language} for a football fan: what has to happen and why the numbers or the news ` +
        `support it. Do not promise any result, do not overstate certainty, and do not invent facts beyond the numbers and the news.`,
      800);
    return parsed?.summary ?? '';
  } catch (err: any) {
    logger.warn(`explanation for ${input.match} failed: ${err?.message ?? err}`);
    return '';
  }
}