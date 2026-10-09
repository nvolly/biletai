import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomBytes } from 'crypto';
import { paths, settings } from '../config/config';

/**
 * Users and their generation credits. Prototype storage: one JSON file on the server
 * (data/users.json). Access keys are shown once at creation and stored only as SHA-256
 * hashes, so a leaked users.json does not leak working keys.
 *
 * Billing is not wired yet: credits are granted by the admin (npm run user) until the
 * payment provider and the legal checks are settled.
 */
export interface User {
  id: string;
  email: string;
  keyHash: string;
  freeLeft: number;      // free generations remaining
  credits: number;       // top-up generations remaining (never expire)
  used: number;          // generations completed
  createdAt: string;
  // A monthly plan: `used` counts this period's generations; the period renews monthly
  // from `periodStart` until `until`.
  plan?: { id: string; periodStart: string; until: string; used: number };
}

const addMonths = (iso: string, n: number) => { const d = new Date(iso); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString(); };
export const planById = (id: string) => settings.plans.find((p) => p.id === id);

/** The user's plan with its period rolled forward to today; null if none or expired. */
export function activePlan(u: User, now = new Date()): (User['plan'] & { def: NonNullable<ReturnType<typeof planById>> }) | null {
  const def = u.plan && planById(u.plan.id);
  if (!u.plan || !def || def.period !== 'month' || now.toISOString() >= u.plan.until) return null;
  let { periodStart, used } = u.plan;
  while (addMonths(periodStart, 1) <= now.toISOString()) { periodStart = addMonths(periodStart, 1); used = 0; }
  return { ...u.plan, periodStart, used, def };
}

/** Generations the plan still has this month. */
export function planLeft(u: User, now = new Date()): number {
  const p = activePlan(u, now);
  return p ? Math.max(0, p.def.generations - p.used) : 0;
}

/** Questions per generation paid with top-up credits. */
const creditQuestions = () => settings.plans.find((p) => p.period === 'once')?.questions ?? settings.server.freeQuestions;

const FILE = path.join(paths.data, 'users.json');

const hash = (key: string) => createHash('sha256').update(key).digest('hex');

function load(): User[] {
  return fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : [];
}

function save(users: User[]) {
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(users, null, 2));
  fs.renameSync(tmp, FILE); // atomic replace: a crash never leaves half a file
}

export function createUser(email: string, credits = 0): { user: User; accessKey: string } {
  const users = load();
  const e = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new Error('invalid email');
  if (users.some((u) => u.email === e)) throw new Error('a user with this email already exists');
  const accessKey = `bai_${randomBytes(24).toString('base64url')}`;
  const user: User = {
    id: randomBytes(8).toString('hex'), email: e, keyHash: hash(accessKey),
    freeLeft: settings.server.freeGenerations, credits, used: 0, createdAt: new Date().toISOString(),
  };
  save([...users, user]);
  return { user, accessKey };
}

export function findByKey(accessKey: string | undefined): User | null {
  if (!accessKey) return null;
  const h = hash(accessKey.trim());
  return load().find((u) => u.keyHash === h) ?? null;
}

export function listUsers(): User[] {
  return load();
}

export function addCredits(email: string, n: number): User {
  const users = load();
  const u = users.find((x) => x.email === email.trim().toLowerCase());
  if (!u) throw new Error('no such user');
  u.credits = Math.max(0, u.credits + n);
  save(users);
  return u;
}

/** A new access key for a user (the old one stops working). */
export function rotateKey(email: string): string {
  const users = load();
  const u = users.find((x) => x.email === email.trim().toLowerCase());
  if (!u) throw new Error('no such user');
  const accessKey = `bai_${randomBytes(24).toString('base64url')}`;
  u.keyHash = hash(accessKey);
  save(users);
  return accessKey;
}

export const canGenerate = (u: User) => u.freeLeft > 0 || planLeft(u) > 0 || u.credits > 0;

/**
 * Charge one generation after it succeeded: free ones first, then this month's plan, then
 * top-up credits. Returns how many "ask about the ticket" questions it comes with.
 */
export function charge(userId: string, now = new Date()): { user: User; questions: number } | null {
  const users = load();
  const u = users.find((x) => x.id === userId);
  if (!u) return null;
  let questions = settings.server.freeQuestions;
  const p = activePlan(u, now);
  if (u.freeLeft > 0) u.freeLeft--;
  else if (p && p.used < p.def.generations) {
    u.plan = { id: p.id, periodStart: p.periodStart, until: p.until, used: p.used + 1 };
    questions = p.def.questions;
  } else if (u.credits > 0) { u.credits--; questions = creditQuestions(); }
  u.used++;
  save(users);
  return { user: u, questions };
}

/**
 * Give a user a plan (admin, until payments are wired): a monthly plan for `months` months
 * starting now, or a one-off pack added to the top-up credits.
 */
export function setPlan(email: string, planId: string, months = 1, now = new Date()): User {
  const def = planById(planId);
  if (!def) throw new Error(`no such plan: ${planId} (${settings.plans.map((p) => p.id).join(', ')})`);
  const users = load();
  const u = users.find((x) => x.email === email.trim().toLowerCase());
  if (!u) throw new Error('no such user');
  if (def.period === 'once') u.credits += def.generations;
  else u.plan = { id: def.id, periodStart: now.toISOString(), until: addMonths(now.toISOString(), months), used: 0 };
  save(users);
  return u;
}
