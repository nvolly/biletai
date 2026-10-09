import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
import { env, paths, settings } from '../config/config';
import { logger } from '../utils/logger';
import { buildModelBank, ModelBank } from '../stages/poisson/modelBank';
import { LEAGUES } from '../stages/poisson/leagues';
import { asBetType, generate, GenerateRequest, GenerationResult } from '../engine/generate';
import { FatalPipelineError } from '../stages/news/newsAgent';
import { canGenerate, charge, createUser, findByKey, User } from './accounts';
import { settleAll, TRACK_FILE } from '../engine/settle';
import { askAboutTicket, parseRequest } from '../stages/news/assistant';
import { asLang, MSG } from '../i18n';

/**
 * BiletAI API server. Holds the AI keys (environment only) and runs every generation;
 * the apps only send parameters and read results, so no key ever ships to a customer.
 *
 *   GET  /v1/health                  status, leagues ready
 *   GET  /v1/me                      the caller's free / paid generations, plans
 *   GET  /v1/leagues                 leagues the models cover
 *   POST /v1/generate                start a generation (betType simple | combo) -> { jobId }
 *   GET  /v1/jobs/:id                progress log and, when done, the tickets
 *   GET  /v1/history                 the caller's recent generations (settled ones carry results)
 *   GET  /v1/track-record            how BiletAI's settled picks actually did
 *   POST /v1/parse                   { text } -> settings for the form (request box)
 *   POST /v1/ask                     { generationId, question } -> { answer, left } (ticket chat)
 *   POST /admin/users                (X-Admin-Token) create a user -> access key
 *
 * Auth: "Authorization: Bearer <access key>". A generation is charged only when it
 * succeeds; one runs at a time server-wide (CPU-bound) and one queued per user.
 */
const PORT = env.PORT ?? settings.server.port;

// ---- model bank: built at start, refreshed every 12h; each refresh brings new results,
// so the results tracker settles past picks right after ----
let bank: ModelBank | null = null;
async function refreshBank() {
  try { bank = await buildModelBank(); } catch (e: any) { logger.error(`model bank failed: ${e?.message ?? e}`); return; }
  try { settleAll(bank); } catch (e: any) { logger.error(`results tracker failed: ${e?.message ?? e}`); }
}
refreshBank();
setInterval(refreshBank, 12 * 3600_000).unref();

// ---- jobs ----
interface Job {
  id: string; userId: string; status: 'queued' | 'running' | 'done' | 'failed';
  request: GenerateRequest; log: string[]; result?: GenerationResult; error?: string; createdAt: string;
}
const jobs = new Map<string, Job>();
const queue: Job[] = [];
let busy = false;

function historyDir(userId: string) {
  const d = path.join(paths.data, 'generations', userId);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

async function pump() {
  if (busy || !queue.length || !bank) return;
  busy = true;
  const job = queue.shift()!;
  job.status = 'running';
  try {
    job.result = await generate(bank, job.request, (l) => job.log.push(l));
    if (job.result.found > 0) {
      charge(job.userId);
      fs.writeFileSync(path.join(historyDir(job.userId), `${job.id}.json`), JSON.stringify(job.result));
    }
    job.status = 'done';
  } catch (e: any) {
    job.status = 'failed';
    // Account problems on our side are not the customer's business: give a generic message.
    job.error = e instanceof FatalPipelineError ? MSG[job.request.lang ?? 'ro'].aiUnavailable : (e?.message ?? String(e));
    logger.error(`job ${job.id} failed: ${e?.message ?? e}`);
  } finally {
    busy = false;
    setTimeout(() => jobs.delete(job.id), 6 * 3600_000).unref();
    pump();
  }
}

// ---- assistant limits: each call costs an AI request, so they're capped ----
const ASK_PER_GENERATION = 10;
const DAILY = { parse: 40, ask: 60 };
const usage = new Map<string, { day: string; n: number }>();
/** Count one use of `kind` today for the user; false once the daily cap is reached. */
function useToday(userId: string, kind: keyof typeof DAILY): boolean {
  const day = new Date().toISOString().slice(0, 10), k = `${kind}:${userId}`;
  const u = usage.get(k);
  if (!u || u.day !== day) { usage.set(k, { day, n: 1 }); return true; }
  if (u.n >= DAILY[kind]) return false;
  u.n++;
  return true;
}

// ---- HTTP ----
function send(res: http.ServerResponse, code: number, data: unknown) {
  res.writeHead(code, {
    // Explicit charset: Romanian diacritics must survive every client (PowerShell and some
    // mobile webviews fall back to Latin-1 without it).
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type, x-lang',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
  });
  res.end(JSON.stringify(data));
}

function body(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (d) => { s += d; if (s.length > 64_000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch { resolve({}); } });
  });
}

function auth(req: http.IncomingMessage): User | null {
  const h = req.headers.authorization ?? '';
  return findByKey(h.startsWith('Bearer ') ? h.slice(7) : undefined);
}

const publicUser = (u: User) => ({ email: u.email, freeLeft: u.freeLeft, credits: u.credits, used: u.used });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const p = url.pathname;
  // The app sends its language with every call; errors and generated text follow it.
  const T = MSG[asLang(req.headers['x-lang'])];
  try {
    if (req.method === 'OPTIONS') return send(res, 204, {});
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(paths.client, 'index.html')));
    }
    if (req.method === 'GET' && p === '/v1/health') {
      return send(res, 200, { ok: true, ready: !!bank, leagues: bank?.leagues.size ?? 0, ai: settings.ai.enabled });
    }
    if (req.method === 'GET' && p === '/v1/leagues') {
      return send(res, 200, LEAGUES.filter((l) => bank?.leagues.has(l.code)).map((l) => ({ code: l.code, name: l.name, country: l.country, stats: l.kind === 'main' })));
    }
    if (p === '/admin/users' && req.method === 'POST') {
      if (!env.ADMIN_TOKEN || req.headers['x-admin-token'] !== env.ADMIN_TOKEN) return send(res, 403, { error: 'forbidden' });
      const b = await body(req);
      const { user, accessKey } = createUser(String(b.email ?? ''), Number(b.credits ?? 0));
      return send(res, 200, { user: publicUser(user), accessKey });
    }

    const user = auth(req);
    if (p.startsWith('/v1/') && !user) return send(res, 401, { error: T.badKey });

    if (req.method === 'GET' && p === '/v1/me') return send(res, 200, { ...publicUser(user!), plans: settings.plans, limits: settings.tickets });
    if (req.method === 'POST' && p === '/v1/generate') {
      if (!canGenerate(user!)) return send(res, 402, { error: T.noCredits, plans: settings.plans });
      if ([...jobs.values()].some((j) => j.userId === user!.id && (j.status === 'queued' || j.status === 'running'))) {
        return send(res, 409, { error: T.busy });
      }
      const b = await body(req);
      const request: GenerateRequest = {
        tickets: Number(b.tickets ?? settings.tickets.defaultTickets), matches: Number(b.matches ?? settings.tickets.defaultMatches),
        betType: asBetType(b.betType),
        minOdds: b.minOdds != null ? Number(b.minOdds) : undefined, maxOdds: b.maxOdds != null ? Number(b.maxOdds) : undefined,
        maxLegs: b.maxLegs != null ? Number(b.maxLegs) : undefined, windowHours: b.windowHours != null ? Number(b.windowHours) : undefined,
        leagues: Array.isArray(b.leagues) ? b.leagues.map(String).slice(0, 60) : [],
        lang: asLang(b.lang ?? req.headers['x-lang']),
      };
      if (![request.tickets, request.matches].every((n) => Number.isFinite(n) && n >= 1)) return send(res, 400, { error: T.minOne });
      const job: Job = { id: randomBytes(9).toString('base64url'), userId: user!.id, status: 'queued', request, log: [], createdAt: new Date().toISOString() };
      jobs.set(job.id, job);
      queue.push(job);
      pump();
      return send(res, 200, { jobId: job.id, position: queue.length });
    }
    const jm = p.match(/^\/v1\/jobs\/([\w-]+)$/);
    if (req.method === 'GET' && jm) {
      const job = jobs.get(jm[1]);
      if (!job || job.userId !== user!.id) return send(res, 404, { error: T.notFound });
      // Re-read the user so the remaining generations reflect a charge made by this job.
      return send(res, 200, { id: job.id, status: job.status, log: job.log, result: job.result, error: job.error, me: publicUser(auth(req) ?? user!) });
    }
    if (req.method === 'POST' && p === '/v1/parse') {
      const b = await body(req);
      const text = String(b.text ?? '').trim();
      if (!text || text.length > 300) return send(res, 400, { error: T.tooLong });
      if (!bank) return send(res, 503, { error: T.aiUnavailable });
      if (!useToday(user!.id, 'parse')) return send(res, 429, { error: T.dailyLimit });
      const leagues = LEAGUES.filter((l) => bank!.leagues.has(l.code));
      const parsed = await parseRequest(text, leagues).catch((e) => { if (e instanceof FatalPipelineError) return 'down' as const; throw e; });
      if (parsed === 'down') return send(res, 503, { error: T.aiUnavailable });
      if (!parsed) return send(res, 422, { error: T.notUnderstood });
      return send(res, 200, parsed);
    }
    if (req.method === 'POST' && p === '/v1/ask') {
      const b = await body(req);
      const id = String(b.generationId ?? ''), question = String(b.question ?? '').trim();
      if (!/^[\w-]{6,40}$/.test(id)) return send(res, 404, { error: T.notFound });
      if (!question || question.length > 500) return send(res, 400, { error: T.tooLong });
      const file = path.join(historyDir(user!.id), `${id}.json`);
      if (!fs.existsSync(file)) return send(res, 404, { error: T.notFound });
      const g = JSON.parse(fs.readFileSync(file, 'utf8')) as GenerationResult;
      const chat = g.chat ?? [];
      if (chat.length >= ASK_PER_GENERATION) return send(res, 429, { error: T.askLimit(ASK_PER_GENERATION) });
      if (!useToday(user!.id, 'ask')) return send(res, 429, { error: T.dailyLimit });
      let answer: string;
      try { answer = await askAboutTicket(g, chat, question, asLang(b.lang ?? req.headers['x-lang'])); } catch (e: any) {
        logger.warn(`ask failed: ${e?.message ?? e}`);
        return send(res, 503, { error: T.aiUnavailable });
      }
      // Re-read before writing: the results tracker may have updated the file meanwhile.
      const fresh = JSON.parse(fs.readFileSync(file, 'utf8')) as GenerationResult;
      fresh.chat = [...(fresh.chat ?? []), { q: question, a: answer, at: new Date().toISOString() }];
      fs.writeFileSync(file, JSON.stringify(fresh));
      return send(res, 200, { answer, left: ASK_PER_GENERATION - fresh.chat.length });
    }
    if (req.method === 'GET' && p === '/v1/track-record') {
      return send(res, 200, fs.existsSync(TRACK_FILE()) ? JSON.parse(fs.readFileSync(TRACK_FILE(), 'utf8')) : null);
    }
    if (req.method === 'GET' && p === '/v1/history') {
      const dir = historyDir(user!.id);
      const items = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
        .map((f) => ({ id: f.slice(0, -5), ...JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as GenerationResult }))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 20);
      return send(res, 200, items);
    }
    send(res, 404, { error: 'not found' });
  } catch (e: any) {
    send(res, 500, { error: e?.message ?? String(e) });
  }
});

server.listen(PORT, () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`\n  BiletAI server on ${url}\n`);
  if (process.argv.includes('--open')) {
    // Development: open the desktop UI in a Chrome app window.
    const chrome = ['ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA']
      .map((v) => process.env[v] && path.join(process.env[v]!, 'Google', 'Chrome', 'Application', 'chrome.exe'))
      .find((pth) => pth && fs.existsSync(pth));
    if (chrome) spawn(chrome, [`--app=${url}`, `--user-data-dir=${path.join(paths.root, '.chrome-app')}`, '--window-size=1200,900'], { detached: true, stdio: 'ignore' }).unref();
  }
});
