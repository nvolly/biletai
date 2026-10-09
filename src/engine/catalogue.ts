import { StatKey } from '../stages/poisson/history';
import { Simulation } from '../stages/poisson/simulate';

/**
 * Every selection TicketMind can put on a ticket, as a test over one simulated match.
 * Generic names (no bookmaker's labels): a user can find the same market anywhere.
 *
 * `family` groups selections that must not share a builder (two lines of the same market);
 * `needs` lists the simulated quantities a selection reads, so leagues without stat models
 * (goals-only "extra" leagues) simply offer fewer markets.
 */
export interface Selection {
  id: string;            // stable, e.g. "goals.over.2.5"
  family: string;        // one per builder
  market: string;        // "Total goals"
  pick: string;          // "Over 2.5"
  needs: ('goals' | StatKey)[];
  test: (s: Simulation, i: number) => boolean;
}

type Side = 'H' | 'A' | 'T';
type Half = 0 | 1 | 2;

const goals = (s: Simulation, i: number, side: Side, half: Half = 0): number => {
  const h = half === 0 ? s.gh[i] : half === 1 ? s.gh1[i] : s.gh[i] - s.gh1[i];
  const a = half === 0 ? s.ga[i] : half === 1 ? s.ga1[i] : s.ga[i] - s.ga1[i];
  return side === 'H' ? h : side === 'A' ? a : h + a;
};

const count = (s: Simulation, i: number, stat: StatKey, side: Side): number => {
  const c = s.counts[stat]!;
  return side === 'H' ? c[0][i] : side === 'A' ? c[1][i] : c[0][i] + c[1][i];
};

const result = (h: number, a: number) => (h > a ? 'H' : h < a ? 'A' : 'D');

/** Over/under pairs on a list of lines. */
function lines(idBase: string, family: string, market: string, needs: Selection['needs'], ls: number[],
  value: (s: Simulation, i: number) => number): Selection[] {
  const out: Selection[] = [];
  for (const l of ls) {
    out.push({ id: `${idBase}.over.${l}`, family, market, pick: `Over ${l}`, needs, test: (s, i) => value(s, i) > l });
    out.push({ id: `${idBase}.under.${l}`, family, market, pick: `Under ${l}`, needs, test: (s, i) => value(s, i) < l });
  }
  return out;
}

/** The catalogue for one fixture (team names go into the labels). */
export function catalogue(home: string, away: string): Selection[] {
  const G: Selection['needs'] = ['goals'];
  const sel: Selection[] = [];

  // Result and double chance
  for (const [k, pick, want] of [['1', home, 'H'], ['X', 'Draw', 'D'], ['2', away, 'A']] as const) {
    sel.push({ id: `result.${k}`, family: 'result', market: 'Match result', pick, needs: G, test: (s, i) => result(s.gh[i], s.ga[i]) === want });
  }
  for (const [k, pick, ok] of [['1X', `${home} or draw`, ['H', 'D']], ['X2', `${away} or draw`, ['A', 'D']], ['12', 'No draw', ['H', 'A']]] as const) {
    sel.push({ id: `dc.${k}`, family: 'dc', market: 'Double chance', pick, needs: G, test: (s, i) => (ok as readonly string[]).includes(result(s.gh[i], s.ga[i])) });
  }

  // Goals
  sel.push(...lines('goals', 'goals', 'Total goals', G, [0.5, 1.5, 2.5, 3.5, 4.5], (s, i) => goals(s, i, 'T')));
  sel.push(...lines('goals.home', 'goals.home', `${home} goals`, G, [0.5, 1.5, 2.5], (s, i) => goals(s, i, 'H')));
  sel.push(...lines('goals.away', 'goals.away', `${away} goals`, G, [0.5, 1.5, 2.5], (s, i) => goals(s, i, 'A')));
  sel.push({ id: 'btts.yes', family: 'btts', market: 'Both teams to score', pick: 'Yes', needs: G, test: (s, i) => s.gh[i] > 0 && s.ga[i] > 0 });
  sel.push({ id: 'btts.no', family: 'btts', market: 'Both teams to score', pick: 'No', needs: G, test: (s, i) => !(s.gh[i] > 0 && s.ga[i] > 0) });
  sel.push(...lines('goals.h1', 'goals.h1', '1st half goals', G, [0.5, 1.5], (s, i) => goals(s, i, 'T', 1)));
  sel.push(...lines('goals.h2', 'goals.h2', '2nd half goals', G, [0.5, 1.5], (s, i) => goals(s, i, 'T', 2)));
  for (const [k, pick, want] of [['1', home, 'H'], ['X', 'Draw', 'D'], ['2', away, 'A']] as const) {
    sel.push({ id: `ht.${k}`, family: 'ht', market: 'Half-time result', pick, needs: G,
      test: (s, i) => result(goals(s, i, 'H', 1), goals(s, i, 'A', 1)) === want });
  }
  for (const line of [-1.5, 1.5]) {
    sel.push({ id: `hcp.home.${line}`, family: 'hcp', market: 'Goal handicap', pick: `${home} ${line > 0 ? '+' : ''}${line}`, needs: G,
      test: (s, i) => s.gh[i] - s.ga[i] + line > 0 });
    sel.push({ id: `hcp.away.${line}`, family: 'hcp', market: 'Goal handicap', pick: `${away} ${line > 0 ? '+' : ''}${line}`, needs: G,
      test: (s, i) => s.ga[i] - s.gh[i] + line > 0 });
  }

  // Corners, cards, shots, shots on target (leagues with stat models only)
  const stat = (key: StatKey, label: string, total: number[], team: number[]) => {
    sel.push(...lines(`${key}`, key, `Total ${label}`, [key], total, (s, i) => count(s, i, key, 'T')));
    sel.push(...lines(`${key}.home`, `${key}.home`, `${home} ${label}`, [key], team, (s, i) => count(s, i, key, 'H')));
    sel.push(...lines(`${key}.away`, `${key}.away`, `${away} ${label}`, [key], team, (s, i) => count(s, i, key, 'A')));
  };
  stat('corners', 'corners', [6.5, 7.5, 8.5, 9.5, 10.5, 11.5, 12.5], [2.5, 3.5, 4.5, 5.5, 6.5]);
  stat('cards', 'cards', [1.5, 2.5, 3.5, 4.5, 5.5, 6.5], [0.5, 1.5, 2.5, 3.5]);
  stat('sot', 'shots on target', [5.5, 6.5, 7.5, 8.5, 9.5, 10.5], [2.5, 3.5, 4.5, 5.5]);
  stat('shots', 'shots', [18.5, 20.5, 22.5, 24.5, 26.5, 28.5], [8.5, 10.5, 12.5, 14.5]);
  return sel;
}
