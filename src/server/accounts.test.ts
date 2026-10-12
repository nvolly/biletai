import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JsonUserStore, SqliteUserStore, User, createUserStore, canGenerate, isPaused, pause, unpause, currentStore, setStore, USERS_DB_FILE } from './accounts';
import { migrateUsers } from './migrate';
import { settings } from '../config/config';

const makeUser = (over: Partial<User> = {}): User => ({
  id: 'u1', email: 'a@b.ro', keyHash: 'hash-u1', freeLeft: 1, credits: 0, used: 0,
  createdAt: '2026-01-01T00:00:00.000Z', ...over,
});

// The live store is constructed at import time against data/ (gitignored, off-limits to
// tests). These tests swap it for a store in a temp folder and restore it afterwards.
let tmpDir: string;
const savedStore = currentStore();

beforeEach(() => {
  tmpDir = fs.mkdtempSync(`${os.tmpdir()}/biletai-pause-`);
  setStore(new JsonUserStore(path.join(tmpDir, 'users.json')));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  setStore(savedStore);
});

const plan = { id: 'pro', periodStart: '2026-09-01T00:00:00.000Z', until: '2026-10-01T00:00:00.000Z', used: 3 };
const withPlan = () => makeUser({ plan: { ...plan } });

describe('JsonUserStore (in a temporary folder)', () => {
  let dir: string;
  let file: string;
  let store: JsonUserStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(`${os.tmpdir()}/biletai-users-`);
    file = path.join(dir, 'users.json');
    store = new JsonUserStore(file);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads an empty list when the file does not exist yet', () => {
    expect(fs.existsSync(file)).toBe(false);
    expect(store.all()).toEqual([]);
  });

  it('writes the file and reads it back', () => {
    store.save([makeUser()]);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(raw).toHaveLength(1);
    expect(raw[0].email).toBe('a@b.ro');
    expect(store.all()).toHaveLength(1);
  });

  it('replaces the whole list on each save', () => {
    store.save([makeUser()]);
    store.save([makeUser({ id: 'u2', email: 'c@d.ro', keyHash: 'hash-u2' })]);
    expect(store.all()).toHaveLength(1);
    expect(store.all()[0].id).toBe('u2');
  });

  it('finds a user by its id', () => {
    store.save([makeUser({ id: 'u9' })]);
    expect(store.findById('u9')?.email).toBe('a@b.ro');
    expect(store.findById('nope')).toBeNull();
  });

  it('finds a user by the key hash', () => {
    store.save([makeUser({ keyHash: 'hash-8' })]);
    expect(store.findByKeyHash('hash-8')?.id).toBe('u1');
    expect(store.findByKeyHash('hash-0')).toBeNull();
  });

  it('finds a user by the email', () => {
    store.save([makeUser({ email: 'x@y.ro' })]);
    expect(store.findByEmail('x@y.ro')?.id).toBe('u1');
    expect(store.findByEmail('missing@nope.ro')).toBeNull();
  });

  it('never leaves a half-written .tmp file after saving', () => {
    store.save([makeUser()]);
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toHaveLength(1);
  });
});

describe('SqliteUserStore (in a temporary folder)', () => {
  let dir: string;
  let file: string;
  let store: SqliteUserStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(`${os.tmpdir()}/biletai-users-db-`);
    file = path.join(dir, 'users.db');
    store = new SqliteUserStore(file);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads an empty list when the database is fresh', () => {
    expect(store.all()).toEqual([]);
  });

  it('writes the users and reads them back', () => {
    store.save([makeUser(), makeUser({ id: 'u2', email: 'c@d.ro', keyHash: 'hash-u2' })]);
    expect(store.all()).toHaveLength(2);
  });

  it('replaces the whole list on each save', () => {
    store.save([makeUser()]);
    store.save([makeUser({ id: 'u9', email: 'z@z.ro', keyHash: 'hash-u9' })]);
    expect(store.all()).toHaveLength(1);
    expect(store.all()[0].id).toBe('u9');
  });

  it('round-trips a user with a monthly plan', () => {
    store.save([withPlan()]);
    const u = store.findByEmail('a@b.ro')!;
    expect(u.plan).toEqual(plan);
  });

  it('finds a user by its id', () => {
    store.save([makeUser({ id: 'u9' })]);
    expect(store.findById('u9')?.email).toBe('a@b.ro');
    expect(store.findById('nope')).toBeNull();
  });

  it('finds a user by the key hash', () => {
    store.save([makeUser({ keyHash: 'hash-8' })]);
    expect(store.findByKeyHash('hash-8')?.id).toBe('u1');
    expect(store.findByKeyHash('hash-0')).toBeNull();
  });

  it('finds a user by the email', () => {
    store.save([makeUser({ email: 'x@y.ro' })]);
    expect(store.findByEmail('x@y.ro')?.id).toBe('u1');
    expect(store.findByEmail('missing@nope.ro')).toBeNull();
  });
});

describe('migrateUsers (JSON -> SQLite, in a temporary folder)', () => {
  let dir: string;
  let jsonFile: string;
  let dbFile: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(`${os.tmpdir()}/biletai-migrate-`);
    jsonFile = path.join(dir, 'users.json');
    dbFile = path.join(dir, 'users.db');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('copies a small sample file and reports the count', () => {
    fs.writeFileSync(jsonFile, JSON.stringify([makeUser(), makeUser({ id: 'u2', email: 'c@d.ro', keyHash: 'hash-u2', plan: { ...plan } })]));
    expect(migrateUsers(jsonFile, dbFile)).toBe(2);
    const db = new SqliteUserStore(dbFile);
    expect(db.all()).toHaveLength(2);
    expect(db.findByEmail('c@d.ro')?.plan?.id).toBe('pro');
  });

  it('is idempotent: a second run still yields the same users', () => {
    fs.writeFileSync(jsonFile, JSON.stringify([makeUser()]));
    expect(migrateUsers(jsonFile, dbFile)).toBe(1);
    expect(migrateUsers(jsonFile, dbFile)).toBe(1);
    const db = new SqliteUserStore(dbFile);
    expect(db.all()).toHaveLength(1);
  });

  it('migrates zero users when the JSON file does not exist yet', () => {
    expect(migrateUsers(jsonFile, dbFile)).toBe(0);
    expect(new SqliteUserStore(dbFile).all()).toEqual([]);
  });
});

describe('createUserStore (picks the store by server.userStore)', () => {
  const original = settings.server.userStore;

  beforeEach(() => {
    settings.server.userStore = 'json';
  });

  afterEach(() => {
    settings.server.userStore = original;
  });

  it('returns the JSON store by default (server.userStore = "json")', () => {
    expect(settings.server.userStore).toBe('json');
    expect(createUserStore()).toBeInstanceOf(JsonUserStore);
  });

  it('returns the SQLite store when server.userStore = "sqlite"', () => {
    settings.server.userStore = 'sqlite';
    const created = createUserStore();
    expect(created).toBeInstanceOf(SqliteUserStore);
    // it points at data/users.db and round-trips a user
    created.save([makeUser()]);
    expect(fs.existsSync(USERS_DB_FILE)).toBe(true);
    expect(new SqliteUserStore(USERS_DB_FILE).findByEmail('a@b.ro')?.id).toBe('u1');
  });
});

describe('self-pause (store in a temp folder)', () => {
  const now = new Date('2026-10-10T12:00:00.000Z');

  it('rejects lengths other than 1, 7 or 30 days', () => {
    currentStore().save([makeUser()]);
    expect(() => pause('a@b.ro', 2)).toThrow(/1, 7 or 30/);
    expect(() => pause('a@b.ro', 0)).toThrow(/1, 7 or 30/);
    expect(() => pause('a@b.ro', 31)).toThrow(/1, 7 or 30/);
  });

  it('rejects an unknown user', () => {
    expect(() => pause('nobody@nope.ro', 1)).toThrow(/no such user/);
    expect(() => unpause('nobody@nope.ro')).toThrow(/no such user/);
  });

  it('sets the pause end the right number of days ahead', () => {
    currentStore().save([makeUser()]);
    expect(pause('a@b.ro', 1, now).pausedUntil).toBe('2026-10-11T12:00:00.000Z');
    currentStore().save([makeUser()]);
    expect(pause('a@b.ro', 7, now).pausedUntil).toBe('2026-10-17T12:00:00.000Z');
    currentStore().save([makeUser()]);
    expect(pause('a@b.ro', 30, now).pausedUntil).toBe('2026-11-09T12:00:00.000Z');
    // the value is what the endpoint reads back
    expect(currentStore().findByEmail('a@b.ro')!.pausedUntil).toBe('2026-11-09T12:00:00.000Z');
  });

  it('reports a pause as active only before its end date', () => {
    currentStore().save([makeUser({ pausedUntil: '2026-10-21T12:00:00.000Z' })]);
    const u = currentStore().findByEmail('a@b.ro')!;
    expect(isPaused(u, new Date('2026-10-10'))).toBe(true);
    expect(isPaused(u, new Date('2026-10-21T12:00:00.000Z'))).toBe(false);
    expect(isPaused(u, new Date('2026-10-22'))).toBe(false);
    expect(isPaused(makeUser(), new Date('2026-10-10'))).toBe(false);
  });

  it('a pause blocks generations even while credits remain, and lifts on its own after', () => {
    currentStore().save([makeUser({ freeLeft: 1, pausedUntil: '2026-10-21T12:00:00.000Z' })]);
    const u = currentStore().findByEmail('a@b.ro')!;
    expect(canGenerate(u, new Date('2026-10-10'))).toBe(false);
    expect(canGenerate(u, new Date('2026-10-22'))).toBe(true);
  });

  it('unpause clears the date, and a past pause does not block', () => {
    currentStore().save([makeUser({ pausedUntil: '2026-10-01T00:00:00.000Z' })]);
    expect(unpause('a@b.ro').pausedUntil).toBeUndefined();
    expect(isPaused(currentStore().findByEmail('a@b.ro')!, new Date('2026-10-10'))).toBe(false);
  });
});
