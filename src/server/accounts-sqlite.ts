import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';
import { createHash } from 'crypto';
import { settings } from '../config/config';
import type { User } from './accounts';
import { activePlan, planById } from './accounts';

/**
 * SQLite backend for users (better-sqlite3). Stores exactly the same User fields as the
 * JSON store in accounts.ts; the plan is stored as one JSON string in its own column.
 * Pass ':memory:' to use an in-memory database (tests).
 */
type Row = {
  id: string; email: string; key_hash: string; free_left: number;
  credits: number; used: number; created_at: string; plan: string | null;
};

export class SqliteUserStore {
  private db: Database.Database;

  constructor(file = ':memory:') {
    this.db = new Database(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS users (
        id          TEXT PRIMARY KEY,
        email       TEXT NOT NULL UNIQUE,
        key_hash    TEXT NOT NULL,
        free_left   INTEGER NOT NULL,
        credits     INTEGER NOT NULL,
        used        INTEGER NOT NULL,
        created_at  TEXT NOT NULL,
        plan        TEXT
      )
    `);
  }

  close(): void {
    this.db.close();
  }

  private rowToUser(r: Row): User {
    const user: User = {
      id: r.id, email: r.email, keyHash: r.key_hash,
      freeLeft: r.free_left, credits: r.credits, used: r.used,
      createdAt: r.created_at,
    };
    if (r.plan) user.plan = JSON.parse(r.plan) as User['plan'];
    return user;
  }

  private byId(userId: string): User | null {
    const r = this.db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as Row | undefined;
    return r ? this.rowToUser(r) : null;
  }

  byEmail(email: string): User | null {
    const r = this.db.prepare('SELECT * FROM users WHERE email = ?').get(email.trim().toLowerCase()) as Row | undefined;
    return r ? this.rowToUser(r) : null;
  }

  private store(u: User): void {
    this.db.prepare(`
      INSERT INTO users (id, email, key_hash, free_left, credits, used, created_at, plan)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET
        email = excluded.email, key_hash = excluded.key_hash, free_left = excluded.free_left,
        credits = excluded.credits, used = excluded.used, created_at = excluded.created_at,
        plan = excluded.plan
    `).run(u.id, u.email, u.keyHash, u.freeLeft, u.credits, u.used, u.createdAt, u.plan ? JSON.stringify(u.plan) : null);
  }

  createUser(email: string, credits = 0): { user: User; accessKey: string } {
    const e = email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new Error('invalid email');
    if (this.byEmail(e)) throw new Error('a user with this email already exists');
    const accessKey = `bai_${randomBytes(24).toString('base64url')}`;
    const user: User = {
      id: randomBytes(8).toString('hex'), email: e,
      keyHash: createHash('sha256').update(accessKey).digest('hex'),
      freeLeft: settings.server.freeGenerations, credits, used: 0,
      createdAt: new Date().toISOString(),
    };
    this.store(user);
    return { user, accessKey };
  }

  findByKey(accessKey: string | undefined): User | null {
    if (!accessKey) return null;
    const h = createHash('sha256').update(accessKey.trim()).digest('hex');
    const r = this.db.prepare('SELECT * FROM users WHERE key_hash = ?').get(h) as Row | undefined;
    return r ? this.rowToUser(r) : null;
  }

  listUsers(): User[] {
    return (this.db.prepare('SELECT * FROM users ORDER BY created_at').all() as Row[]).map((r) => this.rowToUser(r));
  }

  addCredits(email: string, n: number): User {
    const u = this.byEmail(email);
    if (!u) throw new Error('no such user');
    u.credits = Math.max(0, u.credits + n);
    this.store(u);
    return u;
  }

  rotateKey(email: string): string {
    const u = this.byEmail(email);
    if (!u) throw new Error('no such user');
    const accessKey = `bai_${randomBytes(24).toString('base64url')}`;
    u.keyHash = createHash('sha256').update(accessKey).digest('hex');
    this.store(u);
    return accessKey;
  }

  /**
   * Charge one generation after it succeeded: free ones first, then this month's plan,
   * then top-up credits. Returns how many "ask about the ticket" questions it comes with.
   */
  charge(userId: string, now = new Date()): { user: User; questions: number } | null {
    const u = this.byId(userId);
    if (!u) return null;
    let questions = settings.server.freeQuestions;
    const p = activePlan(u, now);
    if (u.freeLeft > 0) u.freeLeft--;
    else if (p && p.used < p.def.generations) {
      u.plan = { id: p.id, periodStart: p.periodStart, until: p.until, used: p.used + 1 };
      questions = p.def.questions;
    } else if (u.credits > 0) { u.credits--; questions = creditQuestions(); }
    u.used++;
    this.store(u);
    return { user: u, questions };
  }

  setPlan(email: string, planId: string, months = 1, now = new Date()): User {
    const def = planById(planId);
    if (!def) throw new Error(`no such plan: ${planId}`);
    const u = this.byEmail(email);
    if (!u) throw new Error('no such user');
    if (def.period === 'once') u.credits += def.generations;
    else u.plan = { id: def.id, periodStart: now.toISOString(), until: addMonths(now.toISOString(), months), used: 0 };
    this.store(u);
    return u;
  }
}

const addMonths = (iso: string, n: number) => { const d = new Date(iso); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString(); };

/** Questions per generation paid with top-up credits. */
const creditQuestions = () => settings.plans.find((p) => p.period === 'once')?.questions ?? settings.server.freeQuestions;
