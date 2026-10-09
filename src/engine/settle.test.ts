import { describe, it, expect } from '@jest/globals';
import { MatchRecord } from '../stages/poisson/history';
import { findRecord, settleGeneration, settleMatch, trackRecord } from './settle';
import type { GenerationResult, TicketMatch } from './generate';

// Arsenal 2-1 Leeds, 1-0 at half-time, 11 corners (7+4), 4 cards, 21 shots.
const record: MatchRecord = {
  league: 'E0', date: '2026-10-10', home: 'Arsenal', away: 'Leeds', hg: 2, ag: 1, hthg: 1, htag: 0,
  stats: { corners: [7, 4], cards: [1, 3], shots: [14, 7], sot: [6, 2], reds: [0, 0] },
};
const fixture = { id: 'E0|Arsenal|Leeds', league: 'E0', leagueName: 'Premier League', country: 'England', home: 'Arsenal', away: 'Leeds', kickoff: '2026-10-10T11:30:00.000Z' };
const leg = (id: string) => ({ id, family: id.split('.')[0], market: id, pick: id, probability: 0.7 });
const match = (ids: string[], adjusted = 0.75): TicketMatch => ({ fixture, legs: ids.map(leg), probability: adjusted, adjusted, fairOdds: 1 / adjusted });

describe('results tracker', () => {
  it('settles each selection with the catalogue test that priced it', () => {
    const r = settleMatch(match(['result.1', 'goals.over.2.5', 'corners.over.10.5', 'btts.yes', 'ht.1']), record);
    expect(r.score).toBe('2-1');
    expect(r.legs).toEqual([true, true, true, true, true]);
    expect(r.won).toBe(true);
  });

  it('one losing selection loses the match', () => {
    const r = settleMatch(match(['result.1', 'goals.under.2.5']), record);
    expect(r.legs).toEqual([true, false]);
    expect(r.won).toBe(false);
  });

  it('leaves a selection open when the data cannot settle it', () => {
    const noHalf: MatchRecord = { ...record, hthg: undefined, htag: undefined, stats: {} };
    const r = settleMatch(match(['result.1', 'ht.1', 'corners.over.9.5']), noHalf);
    expect(r.legs).toEqual([true, null, null]);
    expect(r.won).toBeNull();
  });

  it('finds the played match by teams and date, tolerating UK vs UTC dates', () => {
    expect(findRecord([record], { fixture })).toBe(record);
    expect(findRecord([record], { fixture: { ...fixture, kickoff: '2026-10-11T00:30:00.000Z' } })).toBe(record);
    expect(findRecord([record], { fixture: { ...fixture, kickoff: '2026-10-20T11:30:00.000Z' } })).toBeUndefined();
    expect(findRecord([record], { fixture: { ...fixture, home: 'Leeds', away: 'Arsenal' } })).toBeUndefined();
  });

  it('settles a generation once the match is over, and marks the ticket', () => {
    const g = {
      request: { betType: 'simple' },
      tickets: [{ index: 1, probability: 0.5, fairOdds: 2, matches: [match(['result.1'], 0.72), match(['goals.over.3.5'], 0.65)] }],
    } as unknown as GenerationResult;
    expect(settleGeneration(g, () => record, Date.parse('2026-10-10T12:00:00Z'))).toBe(false); // still playing
    expect(settleGeneration(g, () => record, Date.parse('2026-10-11T12:00:00Z'))).toBe(true);
    expect(g.tickets[0].matches.map((m) => m.result?.won)).toEqual([true, false]);
    expect(g.tickets[0].status).toBe('lost');
    expect(settleGeneration(g, () => record, Date.parse('2026-10-12T12:00:00Z'))).toBe(false); // nothing new

    const tr = trackRecord([g, structuredClone(g)]);
    expect(tr.matches.n).toBe(2);           // the same picks on a second ticket count once
    expect(tr.matches.won).toBe(1);
    expect(tr.byType.simple.n).toBe(2);
    expect(tr.buckets.find((b) => b.from === 0.7)!.won).toBe(1);
    expect(tr.buckets.find((b) => b.from === 0.6)!.won).toBe(0);
    expect(tr.tickets).toMatchObject({ n: 2, won: 0 });
  });
});
