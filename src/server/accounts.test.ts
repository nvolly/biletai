import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JsonUserStore, User } from './accounts';

const makeUser = (over: Partial<User> = {}): User => ({
  id: 'u1', email: 'a@b.ro', keyHash: 'hash-u1', freeLeft: 1, credits: 0, used: 0,
  createdAt: '2026-01-01T00:00:00.000Z', ...over,
});

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
