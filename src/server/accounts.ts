import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomBytes } from 'crypto';
import { DatabaseSync } from 'node:sqlite';
import { paths, settings } from '../config/config';

/**
 * Users and their generation credits. Storage is an implementation of `UserStore`;
 * today that is JSON on one file on the server (data/users.json). Access keys are shown
 * once at creation and stored only as SHA-256 hashes, so a leaked users.json does not leak
 * working keys.
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

/**
 * The SQLite-file implementation: one `users` table, replaced wholesale on save
 * (same shape as `User` columns; the optional `plan` is stored as a JSON blob).
 */
export const USERS_DB_FILE = path.join(paths.data, 'users.db');

const openUsersDb = (file: string) => {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id        TEXT PRIMARY KEY,
      email     TEXT NOT NULL UNIQUE,
      keyHash   TEXT NOT NULL,
      freeLeft  INTEGER NOT NULL,
      credits   INTEGER NOT NULL,
      used      INTEGER NOT NULL,
      createdAt TEXT NOT NULL,
      plan      TEXT
    )
  `);
  return db;
};

export class SqliteUserStore implements UserStore {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    this.db = openUsersDb(file);
  }

  all(): User[] {
    const rows = this.db.prepare('SELECT id, email, keyHash, freeLeft, credits, used, createdAt, plan FROM users').all();
    return rows.map((r) => this.rowToUser(r));
  }

  save(users: User[]) {
    const tx = this.db.prepare('BEGIN');
    const del = this.db.prepare('DELETE FROM users');
    const ins = this.db.prepare(
      'INSERT INTO users (id, email, keyHash, freeLeft, credits, used, createdAt, plan) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    tx.run();
    del.run();
    for (const u of users) {
      ins.run(u.id, u.email, u.keyHash, u.freeLeft, u.credits, u.used, u.createdAt, u.plan ? JSON.stringify(u.plan) : null);
    }
    this.db.exec('COMMIT');
  }

  findById(id: string): User | null {
    const row = this.db.prepare('SELECT id, email, keyHash, freeLeft, credits, used, createdAt, plan FROM users WHERE id = ?').get(id);
    return row ? this.rowToUser(row) : null;
  }

  findByKeyHash(keyHash: string): User | null {
    const row = this.db.prepare('SELECT id, email, keyHash, freeLeft, credits, used, createdAt, plan FROM users WHERE keyHash = ?').get(keyHash);
    return row ? this.rowToUser(row) : null;
  }

  findByEmail(email: string): User | null {
    const row = this.db.prepare('SELECT id, email, keyHash, freeLeft, credits, used, createdAt, plan FROM users WHERE email = ?').get(email);
    return row ? this.rowToUser(row) : null;
  }

  private rowToUser(r: Record<string, unknown>): User {
    const u: User = {
      id: r.id as string, email: r.email as string, keyHash: r.keyHash as string,
      freeLeft: r.freeLeft as number, credits: r.credits as number, used: r.used as number,
      createdAt: r.createdAt as string,
    };
    const plan = r.plan as string | null;
    if (plan !== null) u.plan = JSON.parse(plan);
    return u;
  }
}

/**
 * The live store, used by the account functions below (and the user CLI). Which
 * implementation is picked by `server.userStore` in config/settings.yaml: "json" keeps
 * users in data/users.json, "sqlite" in data/users.db (migrate with npm run users:migrate).
 */
export function createUserStore(): UserStore {
  return settings.server.userStore === 'sqlite'
    ? new SqliteUserStore(USERS_DB_FILE)
    : new JsonUserStore(path.join(paths.data, 'users.json'));
}

export const store: UserStore = createUserStore();

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
