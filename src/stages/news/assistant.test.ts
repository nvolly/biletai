import { describe, it, expect } from '@jest/globals';
import { LEAGUES } from '../poisson/leagues';
import { cleanRequest } from './assistant';

const raw = (over: object = {}) => ({
  understood: true, betType: null, tickets: null, matches: null, minOdds: null, maxOdds: null, maxLegs: null, hours: null, leagues: [], ...over,
} as Parameters<typeof cleanRequest>[0]);

describe('request box', () => {
  it('keeps what was asked and leaves the rest to the form', () => {
    expect(cleanRequest(raw({ betType: 'simple', matches: 3, leagues: ['E0'] }), LEAGUES)).toEqual({
      betType: 'simple', tickets: undefined, matches: 3, minOdds: undefined, maxOdds: undefined, maxLegs: undefined, windowHours: undefined, leagues: ['E0'],
    });
  });

  it('clamps numbers to what the app allows and snaps the time window up', () => {
    const r = cleanRequest(raw({ tickets: 40, matches: 0, maxLegs: 9, hours: 50 }), LEAGUES)!;
    expect(r.tickets).toBe(5);
    expect(r.matches).toBe(1);
    expect(r.maxLegs).toBe(5);
    expect(r.windowHours).toBe(72);
    expect(cleanRequest(raw({ hours: 500 }), LEAGUES)!.windowHours).toBe(144);
  });

  it('drops an odds range that is upside down, and unknown leagues', () => {
    const r = cleanRequest(raw({ minOdds: 2, maxOdds: 1.5, leagues: ['E0', 'XX9', 'E0'] }), LEAGUES)!;
    expect(r.minOdds).toBeUndefined();
    expect(r.maxOdds).toBeUndefined();
    expect(r.leagues).toEqual(['E0']);
  });

  it('refuses requests that are not about football tickets', () => {
    expect(cleanRequest(raw({ understood: false }), LEAGUES)).toBeNull();
  });
});
