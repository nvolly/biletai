import { describe, it, expect, beforeEach } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JsonUserStore, User, setWeeklyLimit, weeklyLeft, charge, weekStart } from './accounts';
import { MSG } from '../i18n';

describe('personal weekly generation limit', () => {
  let dir: string;
  let store: JsonUserStore;
  const mk = (email: string, weeklyLimit?: number): User => {
    const u: User = {
      id: email.replace(/[^a-z0-9]/g, ''), email, keyHash: email,
      freeLeft: 5, credits: 10, used: 0, createdAt: new Date().toISOString(),
    };
    if (weeklyLimit != null) u.weeklyLimit = weeklyLimit;
    store.save([...store.all(), u]);
    return u;
  };
  const byEmail = (email: string) => store.findByEmail(email)!;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bai-weekly-'));
    store = new JsonUserStore(path.join(dir, 'users.json'));
  });

  it('defaults to no cap', () => {
    const u = mk('a@x.test');
    expect(weeklyLeft(u)).toBeNull();
  });

  it('setWeeklyLimit stores the cap', () => {
    mk('a@x.test');
    const u = setWeeklyLimit('a@x.test', 3, store);
    expect(u.weeklyLimit).toBe(3);
    expect(weeklyLeft(u)).toBe(3);
  });

  it('accepts a large reasonable cap and rejects zero/negative/fractional', () => {
    mk('a@x.test');
    expect(() => setWeeklyLimit('a@x.test', 1000, store)).not.toThrow();
    expect(() => setWeeklyLimit('a@x.test', 0, store)).toThrow();
    expect(() => setWeeklyLimit('a@x.test', -1, store)).toThrow();
    expect(() => setWeeklyLimit('a@x.test', 2.5, store)).toThrow();
    expect(() => setWeeklyLimit('missing@x.test', 5, store)).toThrow(/no such user/);
  });

  it('removing the cap (null) makes weeklyLeft null again', () => {
    mk('a@x.test');
    setWeeklyLimit('a@x.test', 5, store);
    const u = setWeeklyLimit('a@x.test', null, store);
    expect(u.weeklyLimit).toBeUndefined();
    expect(weeklyLeft(u)).toBeNull();
  });

  it('charge() bumps the weekly count once a cap exists', () => {
    const u = mk('a@x.test', 2);
    expect(weeklyLeft(byEmail('a@x.test'))).toBe(2);
    charge(u.id, new Date(), store);
    expect(weeklyLeft(byEmail('a@x.test'))).toBe(1);
    charge(u.id, new Date(), store);
    expect(weeklyLeft(byEmail('a@x.test'))).toBe(0);
  });

  it('no cap means the weekly counter never starts', () => {
    const u = mk('a@x.test');
    expect(weeklyLeft(byEmail('a@x.test'))).toBeNull();
    charge(u.id, new Date(), store);
    const after = byEmail('a@x.test');
    expect(after.weekCount).toBeUndefined();
    expect(after.weekStart).toBeUndefined();
  });

  it('a week rollover resets the count automatically', () => {
    const u = mk('a@x.test', 2);
    const now = new Date();
    const ws = weekStart(now).toISOString();
    // pre-seed this week at two charges, persisted like charge() would have written it
    u.weekStart = ws; u.weekCount = 2;
    store.save([...store.all().filter((o) => o.id !== u.id), u]);
    const r = charge(u.id, now, store);
    expect(r).not.toBeNull();
    // charge at the same week keeps counting to 3
    expect(byEmail('a@x.test').weekCount).toBe(3);
    // next Monday: the stored week differs, so the count resets on next charge
    const nextMonday = weekStart(now);
    nextMonday.setUTCDate(nextMonday.getUTCDate() + 7);
    charge(u.id, nextMonday, store);
    const after = byEmail('a@x.test');
    expect(after.weekCount).toBe(1);
    expect(after.weekStart).not.toBe(ws);
    expect(weeklyLeft(after, nextMonday)).toBe(1);
  });

  it('weeklyLeft clamps to zero, never negative', () => {
    mk('a@x.test', 1);
    const u = byEmail('a@x.test');
    u.weekStart = weekStart(new Date()).toISOString(); u.weekCount = 5;
    expect(weeklyLeft(u)).toBe(0);
  });

  it('exposes a friendly RO and EN message with the limit number', () => {
    const ro = MSG.ro.weeklyLimit(3);
    const en = MSG.en.weeklyLimit(3);
    expect(ro).toContain('3');
    expect(en).toContain('3');
    expect(ro).not.toEqual(en);
    // diacritics present in the Romanian line
    expect(ro).toMatch(/[ăâîșțĂÂÎȘȚ]/);
  });
});
