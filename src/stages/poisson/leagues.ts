/**
 * Leagues the models are trained on, keyed by football-data.co.uk's file code.
 *
 * Two file families, and they are NOT equivalent:
 *   - `main` (mmz4281/{season}/{div}.csv) — one file per season, with shots, shots on target,
 *     corners and cards per match. Every stat model can be trained here.
 *   - `extra` (new/{code}.csv) — one file for all seasons, goals and odds only. Only the goals
 *     model exists for these leagues, so tickets there use goal markets only.
 *
 * `country` / `feedLeague` are the names football-data.co.uk's upcoming-fixtures feeds use,
 * so a fixture maps to its league without any name matching.
 */
export interface LeagueDef {
  code: string;
  name: string;          // shown in the app
  country: string;       // football-data country (extra fixtures feed)
  feedLeague?: string;   // football-data league name (extra fixtures feed)
  kind: 'main' | 'extra';
}

const main = (code: string, country: string, name: string): LeagueDef => ({ code, country, name, kind: 'main' });
const extra = (code: string, country: string, feedLeague: string, name = `${country} ${feedLeague}`): LeagueDef =>
  ({ code, country, feedLeague, name, kind: 'extra' });

export const LEAGUES: LeagueDef[] = [
  main('E0', 'England', 'Premier League'), main('E1', 'England', 'Championship'),
  main('E2', 'England', 'League One'), main('E3', 'England', 'League Two'), main('EC', 'England', 'National League'),
  main('SC0', 'Scotland', 'Premiership'), main('SC1', 'Scotland', 'Championship'),
  main('SC2', 'Scotland', 'League One'), main('SC3', 'Scotland', 'League Two'),
  main('D1', 'Germany', 'Bundesliga'), main('D2', 'Germany', '2. Bundesliga'),
  main('I1', 'Italy', 'Serie A'), main('I2', 'Italy', 'Serie B'),
  main('SP1', 'Spain', 'La Liga'), main('SP2', 'Spain', 'La Liga 2'),
  main('F1', 'France', 'Ligue 1'), main('F2', 'France', 'Ligue 2'),
  main('N1', 'Netherlands', 'Eredivisie'), main('B1', 'Belgium', 'Pro League'),
  main('P1', 'Portugal', 'Primeira Liga'), main('T1', 'Turkey', 'Super Lig'), main('G1', 'Greece', 'Super League'),
  extra('ARG', 'Argentina', 'Liga Profesional'), extra('AUT', 'Austria', 'Bundesliga'),
  extra('BRA', 'Brazil', 'Serie A'), extra('CHN', 'China', 'Super League'),
  extra('DNK', 'Denmark', 'Superliga'), extra('FIN', 'Finland', 'Veikkausliiga'),
  extra('IRL', 'Ireland', 'Premier Division'), extra('JPN', 'Japan', 'J1 League'),
  extra('MEX', 'Mexico', 'Liga MX'), extra('NOR', 'Norway', 'Eliteserien'),
  extra('POL', 'Poland', 'Ekstraklasa'), extra('ROU', 'Romania', 'Superliga'),
  extra('SWE', 'Sweden', 'Allsvenskan'), extra('SWZ', 'Switzerland', 'Super League'), extra('USA', 'USA', 'MLS'),
];

export const leagueByCode = (code: string) => LEAGUES.find((l) => l.code === code);

/** The league of a row in football-data's "new leagues" fixtures feed. */
export const leagueForFeed = (country: string, league: string) =>
  LEAGUES.find((l) => l.kind === 'extra' && l.country === country.trim() && l.feedLeague === league.trim());
