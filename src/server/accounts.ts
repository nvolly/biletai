import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomBytes } from 'crypto';
import { paths, settings } from '../config/config';

/**
 * Users and their generation credits. Storage is an implementation of `UserStore`, chosen
 * by `settings.server.userStore`: "json" (a file on the server, data/users.json, the
 * default) or "sqlite" (data/users.db). Access keys are shown once at creation and
 * stored only as SHA-256 hashes, so a leaked store does not leak working keys.
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

/**
 * The store behind accounts: every read and write of the users file goes through it, so
 * the file format (JSON today) can be swapped for a database without touching the logic.
 */
export interface UserStore {
  all(): User[];                       // load all users
  save(users: User[]): void;           // save the whole list
  findById(id: string): User | null;
  findByKeyHash(keyHash: string): User | null;
  findByEmail(email: string): User | null;
}

/**
 * The SQLite implementation: users in one table of `data/users.db`. The same "replace the
 * whole list on save" contract as the JSON store, inside one transaction. Only created when
 * `settings.server.userStore` is "sqlite"; the better-sqlite3 module is loaded on demand,
 * so "json" deployments never load it.
 */
export class SqliteUserStore implements UserStore {
  private db: any; // avoid `require` in the "json" deployment path

  constructor(private readonly file: string) {
    // better-sqlite3 is CJS, so require keeps tsc from adding a package.json "type" field.
    const Database: any = require('better-sqlite3');
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.exec('CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, json TEXT NOT NULL)');
  }

  private rows(): User[] {
    return this.db.prepare('SELECT json FROM users').all().map((r: any) => JSON.parse(r.json));
  }

  all(): User[] {
    return this.rows();
  }

  save(users: User[]) {
    const tx = this.db.transaction((xs: User[]) => {
      this.db.prepare('DELETE FROM users').run();
      const ins = this.db.prepare('INSERT INTO users (id, json) VALUES (?, ?)');
      for (const u of xs) ins.run(u.id, JSON.stringify(u));
    });
    tx(users); // a crash inside the transaction rolls back: no half-written list
  }

  findById(id: string): User | null {
    return this.rows().find((u) => u.id === id) ?? null;
  }

  findByKeyHash(keyHash: string): User | null {
    return this.rows().find((u) => u.keyHash === keyHash) ?? null;
  }

  findByEmail(email: string): User | null {
    return this.rows().find((u) => u.email === email) ?? null;
  }
}

/** The store to open from the `server.userStore` setting ("json" | "sqlite"). */
export function openUserStore(kind: 'json' | 'sqlite', dir: string): UserStore {
  return kind === 'sqlite' ? new SqliteUserStore(path.join(dir, 'users.db')) : new JsonUserStore(path.join(dir, 'users.json'));
}

/** The JSON-file implementation: one array of users, atomically replaced on save. */
export class JsonUserStore implements UserStore {
  constructor(private readonly file: string) {}

  all(): User[] {
    return fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : [];
  }

  save(users: User[]) {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(users, null, 2));
    fs.renameSync(tmp, this.file); // atomic replace: a crash never leaves half a file
  }

  findById(id: string): User | null {
    return this.all().find((u) => u.id === id) ?? null;
  }

  findByKeyHash(keyHash: string): User | null {
    return this.all().find((u) => u.keyHash === keyHash) ?? null;
  }

  findByEmail(email: string): User | null {
    return this.all().find((u) => u.email === email) ?? null;
  }
}

/** The live store, used by the account functions below. */
export const store: UserStore = openUserStore(settings.server.userStore, paths.data);

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

const hash = (key: string) => createHash('sha256').update(key).digest('hex');

export function createUser(email: string, credits = 0): { user: User; accessKey: string } {
  const e = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new Error('invalid email');
  if (store.findByEmail(e)) throw new Error('a user with this email already exists');
  const accessKey = `bai_${randomBytes(24).toString('base64url')}`;
  const user: User = {
    id: randomBytes(8).toString('hex'), email: e, keyHash: hash(accessKey),
    freeLeft: settings.server.freeGenerations, credits, used: 0, createdAt: new Date().toISOString(),
  };
  store.save([...store.all(), user]);
  return { user, accessKey };
}

export function findByKey(accessKey: string | undefined): User | null {
  if (!accessKey) return null;
  return store.findByKeyHash(hash(accessKey.trim()));
}

export function listUsers(): User[] {
  return store.all();
}

export function addCredits(email: string, n: number): User {
  const u = store.findByEmail(email.trim().toLowerCase());
  if (!u) throw new Error('no such user');
  u.credits = Math.max(0, u.credits + n);
  store.save(store.all());
  return u;
}

/** A new access key for a user (the old one stops working). */
export function rotateKey(email: string): string {
  const u = store.findByEmail(email.trim().toLowerCase());
  if (!u) throw new Error('no such user');
  const accessKey = `bai_${randomBytes(24).toString('base64url')}`;
  u.keyHash = hash(accessKey);
  store.save(store.all());
  return accessKey;
}

export const canGenerate = (u: User) => u.freeLeft > 0 || planLeft(u) > 0 || u.credits > 0;

/**
 * Charge one generation after it succeeded: free ones first, then this month's plan, then
 * top-up credits. Returns how many "ask about the ticket" questions it comes with.
 */
export function charge(userId: string, now = new Date()): { user: User; questions: number } | null {
  const u = store.findById(userId);
  if (!u) return null;
  let questions = settings.server.freeQuestions;
  const p = activePlan(u, now);
  if (u.freeLeft > 0) u.freeLeft--;
  else if (p && p.used < p.def.generations) {
    u.plan = { id: p.id, periodStart: p.periodStart, until: p.until, used: p.used + 1 };
    questions = p.def.questions;
  } else if (u.credits > 0) { u.credits--; questions = creditQuestions(); }
  u.used++;
  store.save(store.all());
  return { user: u, questions };
}

/**
 * Give a user a plan (admin, until payments are wired): a monthly plan for `months` months
 * starting now, or a one-off pack added to the top-up credits.
 */
export function setPlan(email: string, planId: string, months = 1, now = new Date()): User {
  const def = planById(planId);
  if (!def) throw new Error(`no such plan: ${planId} (${settings.plans.map((p) => p.id).join(', ')})`);
  const u = store.findByEmail(email.trim().toLowerCase());
  if (!u) throw new Error('no such user');
  if (def.period === 'once') u.credits += def.generations;
  else u.plan = { id: def.id, periodStart: now.toISOString(), until: addMonths(now.toISOString(), months), used: 0 };
  store.save(store.all());
  return u;
}
