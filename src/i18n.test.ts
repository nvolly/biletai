import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MARKETS, MSG } from './i18n';

const BOOKMAKERS = [
  'Superbet', 'Betano', 'Casa Pariurilor', 'Fortuna', 'Unibet', 'Betfair',
  'NetBet', 'Mozzart', 'Maxbet', 'Winbet', 'Stanleybet', 'Vlad Cazino',
  'Admiral', 'Princess', 'Getsbet',
];

const findBookmakers = (text: string): string[] => {
  const low = text.toLowerCase();
  return BOOKMAKERS.filter((b) => low.includes(b.toLowerCase()));
};

type Fn = { (...args: unknown[]): string };

function collect(section: Record<string, unknown>): string[] {
  const out: string[] = [];
  const pushFn = (fn: Fn) => {
    const arity = fn.length;
    if (arity === 0) out.push(fn());
    else out.push(fn(...Array.from({ length: arity }, () => 'x')));
  };
  const walk = (v: unknown) => {
    if (typeof v === 'function') pushFn(v as Fn);
    else if (typeof v === 'string') out.push(v);
    else if (typeof v === 'number') out.push(String(v));
    else if (v !== null && typeof v === 'object')
      for (const child of Object.values(v as Record<string, unknown>)) walk(child);
  };
  for (const v of Object.values(section)) walk(v);
  return out;
}

describe('i18n', () => {
  for (const name of ['MARKETS', 'MSG'] as const) {
    const table = name === 'MARKETS' ? MARKETS : MSG;
    it(`has the same keys in Romanian and English (${name})`, () => {
      const keysOf = (section: Record<string, unknown>): string[] => {
        const keys: string[] = [];
        for (const [k, v] of Object.entries(section)) {
          if (v !== null && typeof v === 'object') keys.push(...keysOf(v as Record<string, unknown>));
          else keys.push(k);
        }
        return keys.sort();
      };
      expect(keysOf(table.ro)).toEqual(keysOf(table.en));
    });

    it(`has non-empty Romanian and English text (${name})`, () => {
      for (const lang of ['ro', 'en'] as const) {
        for (const s of collect(table[lang])) {
          expect(s.trim().length).toBeGreaterThan(0);
        }
      }
    });
  }

  it('mentions no bookmaker brand in src/i18n.ts or client/index.html', () => {
    const root = process.cwd() as string;
    const i18nText = readFileSync(resolve(root, 'src', 'i18n.ts'), 'utf-8');
    const appText = readFileSync(resolve(root, 'client', 'index.html'), 'utf-8');
    expect(findBookmakers(i18nText)).toEqual([]);
    expect(findBookmakers(appText)).toEqual([]);
  });
});
