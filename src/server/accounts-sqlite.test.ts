import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { SqliteUserStore } from './accounts-sqlite';
import { settings } from '../config/config';
import { activePlan } from './accounts';

/**
 * SqliteUserStore tested on an in-memory database.
 * All user fields are stored and round-tripped exactly like in the JSON store.
 */
describe('SqliteUserStore', () => {
  let store: SqliteUserStore;

  beforeEach(() => {
    store = new SqliteUserStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('creates a user with the same shape as the JSON store', () => {
    const { user, accessKey } = store.createUser('Vali@Example.com', 5);
    expect(user.email).toBe('vali@example.com');
    expect(user.freeLeft).toBe(settings.server.freeGenerations);
    expect(user.credits).toBe(5);
    expect(user.used).toBe(0);
    expect(user.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(user.createdAt).toBeTruthy();
    expect(user.plan).toBeUndefined();
    expect(accessKey).toMatch(/^bai_[A-Za-z0-9_-]{24,}$/);

    const found = store.findByKey(accessKey);
    expect(found?.email).toBe('vali@example.com');

    const listed = store.listUsers();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toEqual(user);
  });

  it('rejects an invalid email and a duplicate email', () => {
    store.createUser('ok@example.com');
    expect(() => store.createUser('not-an-email')).toThrow('invalid email');
    expect(() => store.createUser('OK@example.com')).toThrow('a user with this email already exists');
  });

  it('addCredits and rotateKey update the same fields', () => {
    const { accessKey } = store.createUser('a@b.co');
    const before = store.findByKey(accessKey)!;

    const withCredits = store.addCredits('A@B.co', 4);
    expect(withCredits.credits).toBe(Math.max(0, before.credits + 4));

    const newKey = store.rotateKey('a@b.co');
    expect(newKey).not.toBe(accessKey);
    expect(store.findByKey(accessKey)).toBeNull();
    const rotated = store.findByKey(newKey)!;
    expect(rotated.email).toBe('a@b.co');
  });

  it('throws when the email does not exist', () => {
    expect(() => store.addCredits('nobody@nowhere.com', 1)).toThrow('no such user');
    expect(() => store.rotateKey('nobody@nowhere.com')).toThrow('no such user');
    expect(() => store.setPlan('nobody@nowhere.com', 'pro')).toThrow('no such user');
  });

  it('charges free generations first, then the plan, then credits', () => {
    const now = new Date('2026-10-10T12:00:00.000Z');
    const { user } = store.createUser('charge@x.com', 3);
    store.setPlan('charge@x.com', 'pro', 1, now);
    const afterPlan = store.byEmail('charge@x.com')!;
    expect(activePlan(afterPlan, now)?.def.id).toBe('pro');

    // Free first
    const c1 = store.charge(user.id, now)!;
    expect(c1.user.freeLeft).toBe(settings.server.freeGenerations - 1);
    expect(c1.questions).toBe(settings.server.freeQuestions);

    // Both free generations first
    const c2 = store.charge(user.id, now)!;
    expect(c2.user.freeLeft).toBe(settings.server.freeGenerations - 2);
    expect(c2.questions).toBe(settings.server.freeQuestions);

    // Then the plan (questions = plan.questions)
    const c3 = store.charge(user.id, now)!;
    expect(c3.user.freeLeft).toBe(settings.server.freeGenerations - 2);
    expect(c3.user.plan!.used).toBe(1);
    expect(c3.questions).toBe(settings.plans.find((p) => p.id === 'pro')!.questions);

    // Stay on the plan
    const c4 = store.charge(user.id, now)!;
    expect(c4.user.freeLeft).toBe(settings.server.freeGenerations - 2);
    expect(c4.user.plan!.used).toBe(2);

    // Unknown user
    expect(store.charge('missing', now)).toBeNull();
  });

  it('setPlan: monthly sets the plan fields, one-off adds to credits', () => {
    const now = new Date('2026-10-10T12:00:00.000Z');
    const { user } = store.createUser('plan@x.com', 2);

    const monthly = store.setPlan('plan@x.com', 'start', 2, now);
    expect(monthly.plan?.id).toBe('start');
    expect(monthly.plan!.periodStart).toBe(now.toISOString());
    // 2 months later in UTC
    const d = new Date(now); d.setUTCMonth(d.getUTCMonth() + 2);
    expect(monthly.plan!.until).toBe(d.toISOString());
    expect(monthly.plan!.used).toBe(0);
    expect(activePlan(monthly, now)?.def.id).toBe('start');

    const topup = store.setPlan('plan@x.com', 'topup10');
    expect(topup.credits).toBe(user.credits + 10);

    expect(() => store.setPlan('plan@x.com', 'nope')).toThrow('no such plan');
  });

});
