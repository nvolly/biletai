import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { settings } from '../../config/config';
import { getMatchNews } from './newsAgent';
import { createMessage, Reply } from './deepseek';

jest.mock('./deepseek', () => ({
  ...jest.requireActual('./deepseek') as object,
  createMessage: jest.fn(),
}));

const fn = createMessage as unknown as ReturnType<typeof jest.fn>;

/** A research turn: stop_reason and how many web searches the turn used. */
const turn = (stop_reason: string, web_search_requests = 0): Reply => ({
  content: [{ type: 'text', text: 'notes' }], stop_reason,
  usage: { server_tool_use: { web_search_requests } },
});
/** The schema call answering with usable JSON. */
const schema = (): Reply => ({
  content: [{ type: 'text', text: '{"home":{"injured":[],"suspended":[],"doubtful":[],"expectedLineup":[],"lineupChanges":"none","keyPlayersOut":[],"recentForm":"none"},"away":{"injured":[],"suspended":[],"doubtful":[],"expectedLineup":[],"lineupChanges":"none","keyPlayersOut":[],"recentForm":"none"},"context":"none","motivation":"balanced","infoGaps":"none"}' }],
  stop_reason: 'end_turn',
});

// A unique event id per test so the per-match news cache never masks the research calls.
const eventId = () => 'evt_' + Math.random().toString(36).slice(2, 8);

describe('research web-search budget', () => {
  beforeEach(() => { fn.mockClear(); });

  const req = (id: string) => ({ eventId: id, home: 'Alpha', away: 'Beta', competition: 'Test', kickoff: '2026-01-01T12:00:00Z' });

  it('passes only the remaining budget as max_uses on resumed turns', async () => {
    const limit = settings.news.maxSearches;
    const id = eventId();
    // Research turns are the calls that carry the web_search tool; the schema call does not.
    const researchTurns: Reply[] = [turn('pause_turn', limit - 1), turn('end_turn', 1)];
    let researchCall = 0;
    fn.mockImplementation((opts: any) =>
      Promise.resolve(opts.tools ? researchTurns[researchCall++] ?? schema() : schema()));

    const news = await getMatchNews(req(id));
    expect(news).not.toBeNull();

    // The research turns are the calls that carry the web_search tool; the schema call does not.
    const researchCalls = fn.mock.calls.filter((c: any) => c[0].tools);
    // Two research turns (the second ends the run).
    expect(researchCalls.length).toBe(2);
    // Turn 1 gets the full limit; turn 2 gets the remainder after turn 1's `limit - 1` searches.
    expect(researchCalls[0][0].tools![0].max_uses).toBe(limit);
    expect(researchCalls[1][0].tools![0].max_uses).toBe(Math.max(0, limit - (limit - 1)));
    // The schema call carries no tools.
    expect(fn.mock.calls[fn.mock.calls.length - 1][0].tools).toBeUndefined();
  });

  it('stops resuming once the total reaches the limit, even if the model keeps pausing', async () => {
    const limit = settings.news.maxSearches;
    const id = eventId();
    // Every research turn reports a full search budget and keeps pausing; the last call is the schema.
    // A research turn pauses while it is still handed a positive budget (it can use its
    // full allowance each time); once the remaining budget is 0 an end turn is honest, so
    // that is what the model returns. The schema call (no tools) always ends.
    fn.mockImplementation((opts: any) => {
      if (!opts.tools) return Promise.resolve(schema());
      const budget = opts.tools[0].max_uses;
      return Promise.resolve(budget > 0 ? turn('pause_turn', budget) : turn('end_turn', budget));
    });

    const news = await getMatchNews(req(id));
    expect(news).not.toBeNull();

    // The research turns are exactly the calls that carry the web_search tool.
    const researchCalls = fn.mock.calls.filter((c: any) => c[0].tools);
    // Turn 0 spends the whole limit, so the resumed turn 1 is handed a budget of 0 and ends:
    // the research never reaches all four turns.
    expect(researchCalls.length).toBe(2);
    expect(researchCalls[0][0].tools![0].max_uses).toBe(limit);
    expect(researchCalls[1][0].tools![0].max_uses).toBe(0);
  });
});
