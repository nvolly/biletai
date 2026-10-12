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
import { activePlan, canGenerate, charge, createUser, findByKey, isPaused, pause, planLeft, setWeeklyLimit, unpause, weeklyLeft, weekStart, User } from './accounts';
import { logCost, newUsage, withUsage } from '../utils/costMeter';
import { settleAll, TRACK_FILE } from '../engine/settle';
import { askAboutTicket, parseRequest } from '../stages/news/assistant';
import { asLang, MSG } from '../i18n';

/**
 * BiletAI API server. Holds the AI keys (environment only) and runs every generation;
 * the apps only send parameters and read results, so no key ever ships to a customer.
 *
 *   GET  /v1/health                  { status: 'ok', queued, running }, no authentication
 *   GET  /demo                       (public) a real settled ticket + the plans, for visitors
 *   GET  /v1/me                      the caller's free / plan / top-up generations, plans
 *   GET  /v1/leagues                 leagues the models cover
 *   POST /v1/generate                start a generation (betType simple | combo) -> { jobId }
 *   GET  /v1/jobs/:id                progress log and, when done, the tickets
 *   GET  /v1/pause                   the caller's pause state, or the help link with no body
 *   POST /v1/pause                   { days: 1 | 7 | 30 } pause; { days: 0 } lifts the pause
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

// ---- jobs ----
interface Job {
  id: string; userId: string; status: 'queued' | 'running' | 'done' | 'failed';
  request: GenerateRequest; log: string[]; result?: GenerationResult; error?: string; createdAt: string;
}
const jobs = new Map<string, Job>();
const queue: Job[] = [];
let busy = false;

/** Public status for load monitors: no authentication, no user data. */
export const health = () => ({ status: 'ok' as const, queued: queue.length, running: busy });

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
  const used = newUsage();
  try {
    job.result = await withUsage(used, () => generate(bank!, job.request, (l) => job.log.push(l)));
    if (job.result.found > 0) {
      const paid = charge(job.userId);
      job.result.questionsAllowed = paid?.questions ?? settings.server.freeQuestions;
      fs.writeFileSync(path.join(historyDir(job.userId), `${job.id}.json`), JSON.stringify(job.result));
    }
    job.status = 'done';
  } catch (e: any) {
    job.status = 'failed';
    // Account problems on our side are not the customer's business: give a generic message.
    job.error = e instanceof FatalPipelineError ? MSG[job.request.lang ?? 'ro'].aiUnavailable : (e?.message ?? String(e));
    logger.error(`job ${job.id} failed: ${e?.message ?? e}`);
  } finally {
    // Failed runs cost money too, so every run is logged.
    logCost('generation', job.userId, used, { ref: job.id, matches: job.result?.found ?? 0 });
    busy = false;
    setTimeout(() => jobs.delete(job.id), 6 * 3600_000).unref();
    pump();
  }
}

// ---- demo: a real BiletAI ticket anyone can see before signing in ----
let demo: { at: number; g: GenerationResult | null } | null = null;
/**
 * The newest AI generation whose tickets are all settled (so the scoreboard shows real
 * results), else the newest with any result, else the newest. Chat and id are dropped, so
 * nothing personal is shown and the demo can't be used to ask questions.
 */
function demoGeneration(): GenerationResult | null {
  if (demo && Date.now() - demo.at < 10 * 60_000) return demo.g;
  const root = path.join(paths.data, 'generations');
  const all: GenerationResult[] = [];
  if (fs.existsSync(root)) for (const u of fs.readdirSync(root)) for (const f of fs.readdirSync(path.join(root, u))) {
    if (!f.endsWith('.json')) continue;
    try { const g = JSON.parse(fs.readFileSync(path.join(root, u, f), 'utf8')) as GenerationResult; if (g.aiUsed && g.tickets.length) all.push(g); } catch {}
  }
  all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const settled = (g: GenerationResult) => g.tickets.every((tk) => tk.status);
  const some = (g: GenerationResult) => g.tickets.some((tk) => tk.matches.some((m) => m.result));
  const pick = all.find(settled) ?? all.find(some) ?? all[0] ?? null;
  const g = pick ? { ...pick, chat: undefined, questionsAllowed: undefined } : null;
  demo = { at: Date.now(), g };
  return g;
}

const publicPlans = () => settings.plans.map(({ id, name, period, priceRon, generations, questions, featured }) => ({ id, name, period, priceRon, generations, questions, featured }));

/** Hours until the current ISO week (Monday 00:00 UTC) ends, for a 429 retry-after hint. */
const hoursToWeekStart = (now = new Date()) => {
  const end = weekStart(now);
  end.setUTCDate(end.getUTCDate() + 7);
  return Math.max(0, Math.ceil((end.getTime() - now.getTime()) / 3600_000));
};

// ---- assistant limits: each call costs an AI request, so they're capped ----
const ASK_PER_GENERATION = 10;   // generations made before plans existed
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

const publicUser = (u: User) => {
  const p = activePlan(u);
  return {
    email: u.email, freeLeft: u.freeLeft, credits: u.credits, used: u.used,
    plan: p ? { id: p.id, name: p.def.name, left: planLeft(u), generations: p.def.generations, questions: p.def.questions, until: p.until } : null,
    paused: isPaused(u) ? u.pausedUntil! : null,
  };
};

/** The state of the caller's self-pause: the date it lifts, or null while not paused. */
const pauseState = (u: User) => (isPaused(u) ? u.pausedUntil! : null);

/** A pause end as a calendar-day string, for calm messages ("până pe 2026-10-20"). */
const fmtUntil = (iso: string) => new Date(iso).toISOString().slice(0, 10);

/** Whole days left in a pause (at least 1 while it is active), for the calm message. */
const remainingDays = (iso: string) => Math.max(1, Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000));

export const handler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
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
    // Public, before sign-in: the demo ticket and the plans, so a visitor sees what they'd get.
    if (req.method === 'GET' && p === '/demo') return send(res, 200, { generation: demoGeneration(), plans: publicPlans(), freeGenerations: settings.server.freeGenerations });
    if (req.method === 'GET' && p === '/v1/health') {
      // Public, no user data: a load monitor only.
      return send(res, 200, health());
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

    if (req.method === 'GET' && p === '/v1/me') return send(res, 200, { ...publicUser(user!), plans: publicPlans(), limits: settings.tickets, weekly: { limit: user!.weeklyLimit ?? null, left: weeklyLeft(user!) ?? null } });
    if (req.method === 'POST' && p === '/v1/limit') {
      const b = await body(req);
      const raw = b.limit;
      if (raw !== null && raw !== undefined && (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1)) return send(res, 400, { error: T.invalidLimit });
      try {
        const u = setWeeklyLimit(user!.email, raw == null ? null : raw);
        return send(res, 200, { weekly: { limit: u.weeklyLimit ?? null, left: weeklyLeft(u) ?? null } });
      } catch (e: any) {
        return send(res, 400, { error: e?.message ?? String(e) });
      }
    }
    // A user can block their own generations for a while (1, 7 or 30 days) and un-block.
    if (p === '/v1/pause' && (req.method === 'GET' || req.method === 'POST')) {
      if (req.method === 'GET') return send(res, 200, { paused: pauseState(user!) });
      const b = await body(req);
      const days = Math.trunc(Number(b.days ?? 0));
      const u = user!;
      if (days === 0) { const n = unpause(u.email); return send(res, 200, { paused: pauseState(n), message: T.unpause }); }
      if (![1, 7, 30].includes(days)) return send(res, 400, { error: T.pauseInvalid, paused: pauseState(u) });
      const p = pause(u.email, days);
      return send(res, 200, { paused: pauseState(p), message: T.pausedSet(days, fmtUntil(p.pausedUntil!)) });
    }
    if (req.method === 'POST' && p === '/v1/generate') {
      // A paused user is answered calmly and pointed at help; nothing is queued or charged.
      if (isPaused(user!)) return send(res, 403, { error: T.paused(remainingDays(user!.pausedUntil!), fmtUntil(user!.pausedUntil!), settings.server.helpUrl), paused: user!.pausedUntil! });
      if (!canGenerate(user!)) return send(res, 402, { error: T.noCredits, plans: publicPlans() });
      const wleft = weeklyLeft(user!);
      if (wleft !== null && wleft <= 0) return send(res, 429, { error: T.weeklyLimit(user!.weeklyLimit!), retryAfterHours: hoursToWeekStart() });
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
      const used = newUsage();
      const parsed = await withUsage(used, () => parseRequest(text, leagues))
        .catch((e) => { if (e instanceof FatalPipelineError) return 'down' as const; throw e; })
        .finally(() => logCost('parse', user!.id, used));
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
      const allowed = g.questionsAllowed ?? ASK_PER_GENERATION;
      if (chat.length >= allowed) return send(res, 429, { error: T.askLimit(allowed) });
      if (!useToday(user!.id, 'ask')) return send(res, 429, { error: T.dailyLimit });
      let answer: string;
      const used = newUsage();
      try { answer = await withUsage(used, () => askAboutTicket(g, chat, question, asLang(b.lang ?? req.headers['x-lang']))); } catch (e: any) {
        logger.warn(`ask failed: ${e?.message ?? e}`);
        return send(res, 503, { error: T.aiUnavailable });
      } finally { logCost('ask', user!.id, used, { ref: id }); }
      // Re-read before writing: the results tracker may have updated the file meanwhile.
      const fresh = JSON.parse(fs.readFileSync(file, 'utf8')) as GenerationResult;
      fresh.chat = [...(fresh.chat ?? []), { q: question, a: answer, at: new Date().toISOString() }];
      fs.writeFileSync(file, JSON.stringify(fresh));
      return send(res, 200, { answer, left: allowed - fresh.chat.length });
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
};

// Only start the server and the 12h model refresh when the file is run directly
// (`npm run server` / `npm run app`); when imported (tests) nothing listens.
const isMain = process.argv[1] ? require('path').resolve(process.argv[1]) === require('path').resolve(__filename) : false;
if (isMain) {
  refreshBank();
  setInterval(refreshBank, 12 * 3600_000).unref();

  const server = http.createServer(handler);
  // A generation keeps the event loop busy for ~15 s of simulation. With Node's 5 s default the
  // idle-socket timer fires right after, and clients polling on a kept-alive connection get
  // ECONNRESET. A longer keep-alive avoids that (moving generation to a worker thread is on the
  // to-do list).
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

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
}
