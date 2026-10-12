import { describe, it, expect } from '@jest/globals';
import { MatchRecord } from '../stages/poisson/history';
import { CALIBRATION_EDGES, addCalibration, bucketIndexFor, finishCalibration, formatCalibration, makeCalibrationBuckets, findRecord, settleGeneration, settleMatch, trackRecord } from './settle';
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

  it('bucketing: a pick lands in the settle bucket for its shown probability', () => {
    expect(CALIBRATION_EDGES[0]).toBe(0.5);
    expect(bucketIndexFor(0.5)).toBe(0);    // from is included
    expect(bucketIndexFor(0.59)).toBe(0);
    expect(bucketIndexFor(0.6)).toBe(1);    // the lower edge starts the next bucket
    expect(bucketIndexFor(0.85)).toBe(3);
    expect(bucketIndexFor(0.9)).toBe(4);
    expect(bucketIndexFor(1)).toBe(4);      // the top bucket caps at 1
    expect(bucketIndexFor(0.49)).toBe(-1);  // below the first bucket: ignored, like the tracker
  });

  it('bucketing: buckets are fresh, zeroed and labeled by edge', () => {
    const b = makeCalibrationBuckets();
    expect(b.length).toBe(CALIBRATION_EDGES.length - 1);
    expect(b[0]).toMatchObject({ from: 0.5, to: 0.6, label: '50–60%', n: 0, sumP: 0, won: 0 });
    expect(b[4]).toMatchObject({ from: 0.9, to: 1, label: '90–100%' });
  });

  it('calibration: accumulates count and win rate, then finishes the table', () => {
    const acc = makeCalibrationBuckets();
    addCalibration(acc, 0.55, true);
    addCalibration(acc, 0.58, false);   // mean shown prob 0.565, 1 of 2 wins
    addCalibration(acc, 0.92, true);    // falls in the 90–100% bucket
    addCalibration(acc, 0.4, true);     // below the buckets: ignored
    const rows = finishCalibration(acc);
    const low = rows.find((r) => r.from === 0.5)!;
    expect(low.n).toBe(2);
    expect(low.predicted).toBeCloseTo(0.565);
    expect(low.actual).toBe(0.5);
    const high = rows.find((r) => r.from === 0.9)!;
    expect(high.n).toBe(1);
    expect(high.actual).toBe(1);
    expect(rows.every((r) => r.predicted <= 1 && r.actual <= 1)).toBe(true);
  });

  it('calibration: an empty bucket reports zero hits, not NaN', () => {
    const rows = finishCalibration(makeCalibrationBuckets());
    expect(rows.every((r) => r.n === 0 && r.predicted === 0 && r.actual === 0)).toBe(true);
  });

  it('calibration: the printer shows per-bucket count and both rates', () => {
    const acc = makeCalibrationBuckets();
    addCalibration(acc, 0.55, true);
    addCalibration(acc, 0.58, false);
    const text = formatCalibration(finishCalibration(acc));
    expect(text).toContain('n=   2');
    expect(text).toContain('predicted= 56%');
    expect(text).toContain('actual= 50%');
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
    expect(tr.calibration.find((r) => r.from === 0.7)!).toMatchObject({ n: 1, predicted: 0.72, actual: 1 });
    expect(tr.calibration.find((r) => r.from === 0.6)!).toMatchObject({ n: 1, predicted: 0.65, actual: 0 });
    expect(tr.tickets).toMatchObject({ n: 2, won: 0 });
  });
});
