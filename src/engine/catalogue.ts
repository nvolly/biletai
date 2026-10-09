import { StatKey } from '../stages/poisson/history';
import { Simulation } from '../stages/poisson/simulate';
import { Lang, MARKETS } from '../i18n';

/**
 * Every selection BiletAI can put on a ticket, as a test over one simulated match.
 * Labels are the standard Romanian football market names, so a user finds the same market anywhere.
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
  value: (s: Simulation, i: number) => number, L: (typeof MARKETS)[Lang]): Selection[] {
  const out: Selection[] = [];
  for (const l of ls) {
    out.push({ id: `${idBase}.over.${l}`, family, market, pick: `${L.over} ${l}`, needs, test: (s, i) => value(s, i) > l });
    out.push({ id: `${idBase}.under.${l}`, family, market, pick: `${L.under} ${l}`, needs, test: (s, i) => value(s, i) < l });
  }
  return out;
}

/** The catalogue for one fixture, labelled in `lang` (team names go into the labels). */
export function catalogue(home: string, away: string, lang: Lang = 'ro'): Selection[] {
  const L = MARKETS[lang];
  const G: Selection['needs'] = ['goals'];
  const sel: Selection[] = [];

  // Result and double chance
  for (const [k, pick, want] of [['1', home, 'H'], ['X', L.draw, 'D'], ['2', away, 'A']] as const) {
    sel.push({ id: `result.${k}`, family: 'result', market: L.result, pick, needs: G, test: (s, i) => result(s.gh[i], s.ga[i]) === want });
  }
  for (const [k, pick, ok] of [['1X', L.orDraw(home), ['H', 'D']], ['X2', L.orDraw(away), ['A', 'D']], ['12', L.noDraw, ['H', 'A']]] as const) {
    sel.push({ id: `dc.${k}`, family: 'dc', market: L.dc, pick, needs: G, test: (s, i) => (ok as readonly string[]).includes(result(s.gh[i], s.ga[i])) });
  }

  // Goals
  sel.push(...lines('goals', 'goals', L.goals, G, [0.5, 1.5, 2.5, 3.5, 4.5], (s, i) => goals(s, i, 'T'), L));
  sel.push(...lines('goals.home', 'goals.home', L.teamGoals(home), G, [0.5, 1.5, 2.5], (s, i) => goals(s, i, 'H'), L));
  sel.push(...lines('goals.away', 'goals.away', L.teamGoals(away), G, [0.5, 1.5, 2.5], (s, i) => goals(s, i, 'A'), L));
  sel.push({ id: 'btts.yes', family: 'btts', market: L.btts, pick: L.yes, needs: G, test: (s, i) => s.gh[i] > 0 && s.ga[i] > 0 });
  sel.push({ id: 'btts.no', family: 'btts', market: L.btts, pick: L.no, needs: G, test: (s, i) => !(s.gh[i] > 0 && s.ga[i] > 0) });
  sel.push(...lines('goals.h1', 'goals.h1', L.h1, G, [0.5, 1.5], (s, i) => goals(s, i, 'T', 1), L));
  sel.push(...lines('goals.h2', 'goals.h2', L.h2, G, [0.5, 1.5], (s, i) => goals(s, i, 'T', 2), L));
  for (const [k, pick, want] of [['1', home, 'H'], ['X', L.draw, 'D'], ['2', away, 'A']] as const) {
    sel.push({ id: `ht.${k}`, family: 'ht', market: L.ht, pick, needs: G,
      test: (s, i) => result(goals(s, i, 'H', 1), goals(s, i, 'A', 1)) === want });
  }
  for (const line of [-1.5, 1.5]) {
    sel.push({ id: `hcp.home.${line}`, family: 'hcp', market: L.hcp, pick: `${home} ${line > 0 ? '+' : ''}${line}`, needs: G,
      test: (s, i) => s.gh[i] - s.ga[i] + line > 0 });
    sel.push({ id: `hcp.away.${line}`, family: 'hcp', market: L.hcp, pick: `${away} ${line > 0 ? '+' : ''}${line}`, needs: G,
      test: (s, i) => s.ga[i] - s.gh[i] + line > 0 });
  }

  // Corners, cards, shots, shots on target (leagues with stat models only)
  const stat = (key: StatKey, label: string, total: number[], team: number[]) => {
    sel.push(...lines(`${key}`, key, L.total(label), [key], total, (s, i) => count(s, i, key, 'T'), L));
    sel.push(...lines(`${key}.home`, `${key}.home`, L.team(label, home), [key], team, (s, i) => count(s, i, key, 'H'), L));
    sel.push(...lines(`${key}.away`, `${key}.away`, L.team(label, away), [key], team, (s, i) => count(s, i, key, 'A'), L));
  };
  stat('corners', L.corners, [6.5, 7.5, 8.5, 9.5, 10.5, 11.5, 12.5], [2.5, 3.5, 4.5, 5.5, 6.5]);
  stat('cards', L.cards, [1.5, 2.5, 3.5, 4.5, 5.5, 6.5], [0.5, 1.5, 2.5, 3.5]);
  stat('sot', L.sot, [5.5, 6.5, 7.5, 8.5, 9.5, 10.5], [2.5, 3.5, 4.5, 5.5]);
  stat('shots', L.shots, [18.5, 20.5, 22.5, 24.5, 26.5, 28.5], [8.5, 10.5, 12.5, 14.5]);
  return sel;
}
