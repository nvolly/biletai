import { describe, it, expect } from '@jest/globals';
import { MatchRecord, dataQuality, TeamDataQuality } from './history';
import { LeagueModels, ModelBank, teamData, modelFor } from './modelBank';
import { settings } from '../../config/config';

const team = (matches: number, daysSinceLast: number): TeamDataQuality => ({ matches, daysSinceLast });

describe('dataQuality', () => {
  const maxStale = settings.model.maxStaleDays;

  it('good when both teams are within maxStaleDays and have plenty of history', () => {
    expect(dataQuality(team(12, 3), team(15, 7), maxStale)).toBe('good');
    expect(dataQuality(team(10, 0), team(10, maxStale), maxStale)).toBe('good'); // exactly maxStaleDays is fresh
  });

  it('fair when both are fresh but at least one has thin history', () => {
    expect(dataQuality(team(5, 2), team(20, 3), maxStale)).toBe('fair');
    expect(dataQuality(team(4, 1), team(6, 9), maxStale)).toBe('fair');
  });

  it('limited when a team played longer ago than maxStaleDays', () => {
    expect(dataQuality(team(12, maxStale + 1), team(20, 2), maxStale)).toBe('limited');
    expect(dataQuality(team(0, Infinity), team(0, Infinity), maxStale)).toBe('limited');
    expect(dataQuality(team(20, maxStale + 5), team(20, maxStale + 4), maxStale)).toBe('limited');
  });
});

/** A tiny league: Alpha vs Zulu and Beta vs Zulu, newest last. Alpha/Beta matches come from the goals model. */
function fakeLeague(asOf: Date) {
  type QualityFixture = { ok: true; model: unknown; modelled: string[]; quality: 'good' | 'fair' | 'limited' };
  const records: MatchRecord[] = [
    { league: 'T', date: '2026-10-08', home: 'Alpha', away: 'Zulu', hg: 1, ag: 0, stats: {} },
    { league: 'T', date: '2026-10-09', home: 'Beta', away: 'Zulu', hg: 0, ag: 1, stats: {} },
  ];
  const goals = {
    stat: 'goals', league: 'T', baseHome: 1.2, baseAway: 0.9, dispersion: 1,
    teams: { Alpha: { for: 1, against: 1, matches: 14 }, Beta: { for: 1, against: 1, matches: 8 }, Zulu: { for: 1, against: 1, matches: 12 } },
    rho: -0.1, firstHalfShare: 0.45,
  };
  const lm = { def: {}, records, goals, counts: {}, staleDays: 0 } as unknown as LeagueModels;
  const bank = { asOf, leagues: new Map([['T', lm]]), correlation: [], chol: [] } as unknown as ModelBank;
  const call = (league: string, home: string, away: string): QualityFixture => {
    const r = modelFor(bank, league, home, away);
    if (!r.ok) throw new Error(r.reason);
    return r as QualityFixture;
  };
  return { bank, lm, call };
}

describe('teamData and per-match data quality via modelFor', () => {
  const asOf = new Date('2026-10-10T00:00:00Z');

  it('teamData reports the matches from the model and the days since the last played match', () => {
    const { bank, lm } = fakeLeague(asOf);
    expect(teamData(lm, 'Alpha', asOf)).toEqual({ matches: 14, daysSinceLast: 2 });
    expect(teamData(lm, 'Beta', asOf)).toEqual({ matches: 8, daysSinceLast: 1 });
    expect(teamData(lm, 'Nobody', asOf)).toEqual({ matches: 0, daysSinceLast: Infinity });
    expect(bank.asOf).toBe(asOf);
  });

  it('modelFor attaches a data quality from how fresh each team is and how much history each has', () => {
    const { bank, lm, call } = fakeLeague(asOf);

    // both fresh: Alpha (14) is thick, Beta (8) is thin -> fair
    let r = call('T', 'Alpha', 'Beta');
    expect(r.quality).toBe('fair');

    // make both thick -> good
    lm.goals.teams.Beta.matches = 12;
    r = call('T', 'Alpha', 'Beta');
    expect(r.quality).toBe('good');

    // Beta played out of the window -> limited, even with thick history
    lm.records[1].date = '2025-01-01';
    r = call('T', 'Alpha', 'Beta');
    expect(r.quality).toBe('limited');
  });
});
