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
  credits: number;       // paid generations remaining
  used: number;          // generations completed
  createdAt: string;
}

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

export const canGenerate = (u: User) => u.freeLeft > 0 || u.credits > 0;

/** Charge one generation after it succeeded: free ones first. */
export function charge(userId: string): User | null {
  const users = load();
  const u = users.find((x) => x.id === userId);
  if (!u) return null;
  if (u.freeLeft > 0) u.freeLeft--; else if (u.credits > 0) u.credits--;
  u.used++;
  save(users);
  return u;
}
