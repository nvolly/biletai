import { describe, it, expect } from '@jest/globals';
import { activePlan, canGenerate, planLeft, User } from './accounts';
import { newUsage, record, usd, withUsage } from '../utils/costMeter';

const user = (plan?: User['plan'], freeLeft = 0, credits = 0): User =>
  ({ id: 'u', email: 'a@b.ro', keyHash: '', freeLeft, credits, used: 0, createdAt: '2026-01-01T00:00:00.000Z', plan });

describe('plans', () => {
  const pro = { id: 'pro', periodStart: '2026-10-01T00:00:00.000Z', until: '2027-01-01T00:00:00.000Z', used: 39 };

  it('counts what is left of this month', () => {
    expect(planLeft(user(pro), new Date('2026-10-20'))).toBe(1);
    expect(canGenerate(user({ ...pro, used: 40 }))).toBe(false);
  });

  it('renews the generations every month from the start date', () => {
    const p = activePlan(user({ ...pro, used: 40 }), new Date('2026-12-05'))!;
    expect(p.periodStart).toBe('2026-12-01T00:00:00.000Z');
    expect(p.used).toBe(0);
    expect(planLeft(user({ ...pro, used: 40 }), new Date('2026-12-05'))).toBe(40);
  });

  it('stops at the end date, and ignores unknown plans', () => {
    expect(activePlan(user(pro), new Date('2027-01-02'))).toBeNull();
    expect(activePlan(user({ ...pro, id: 'gold' }), new Date('2026-10-20'))).toBeNull();
  });

  it('free generations and top-up credits still count without a plan', () => {
    expect(canGenerate(user(undefined, 1))).toBe(true);
    expect(canGenerate(user(undefined, 0, 2))).toBe(true);
    expect(canGenerate(user())).toBe(false);
  });
});

describe('cost meter', () => {
  it('collects usage from parallel work into the right meter', async () => {
    const a = newUsage(), b = newUsage();
    const work = (n: number) => Promise.all(Array.from({ length: n }, async () => {
      await new Promise((r) => setTimeout(r, 1));
      record({ deepseekCalls: 1, deepseekIn: 1000, deepseekOut: 100, jevCalls: 1, jevIn: 2000 });
    }));
    await Promise.all([withUsage(a, () => work(3)), withUsage(b, () => work(2))]);
    expect(a.deepseekCalls).toBe(3);
    expect(b.deepseekCalls).toBe(2);
    record({ deepseekCalls: 5 }); // outside any meter: ignored
    expect(a.deepseekCalls + b.deepseekCalls).toBe(5);
  });

  it('prices tokens at the configured rates', () => {
    const u = { ...newUsage(), deepseekIn: 1_000_000, deepseekOut: 1_000_000, jevIn: 1_000_000 };
    expect(usd(u)).toBeCloseTo(0.3 + 1.2 + 0.042, 10);
  });
});
