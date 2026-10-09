/**
 * Market probabilities read straight off a scoreline matrix. Every market, and every
 * combination of markets, is a set of scorelines — so a combination's probability is the
 * mass of the cells where ALL its legs win, never the product of the legs' probabilities.
 */
export type ScorePred = (home: number, away: number) => boolean;

export function probWhere(matrix: number[][], pred: ScorePred): number {
  let p = 0;
  for (let h = 0; h < matrix.length; h++) for (let a = 0; a < matrix[h].length; a++) if (pred(h, a)) p += matrix[h][a];
  return p;
}

/** Joint probability of several score-based legs on the same match. */
export function jointProb(matrix: number[][], legs: ScorePred[]): number {
  return probWhere(matrix, (h, a) => legs.every((leg) => leg(h, a)));
}

export const pred = {
  home: (): ScorePred => (h, a) => h > a,
  draw: (): ScorePred => (h, a) => h === a,
  away: (): ScorePred => (h, a) => h < a,
  dc1X: (): ScorePred => (h, a) => h >= a,
  dcX2: (): ScorePred => (h, a) => h <= a,
  dc12: (): ScorePred => (h, a) => h !== a,
  over: (line: number): ScorePred => (h, a) => h + a > line,
  under: (line: number): ScorePred => (h, a) => h + a < line,
  btts: (): ScorePred => (h, a) => h > 0 && a > 0,
  noBtts: (): ScorePred => (h, a) => h === 0 || a === 0,
  homeOver: (line: number): ScorePred => (h) => h > line,
  awayOver: (line: number): ScorePred => (_h, a) => a > line,
  score: (x: number, y: number): ScorePred => (h, a) => h === x && a === y,
};

export interface MatrixMarkets {
  home: number; draw: number; away: number;
  dc1X: number; dcX2: number; dc12: number;
  btts: number;
  over: Record<string, number>;      // "0.5".."4.5"
  homeOver: Record<string, number>;  // team totals
  awayOver: Record<string, number>;
}

export function marketsFromMatrix(m: number[][]): MatrixMarkets {
  const lines = [0.5, 1.5, 2.5, 3.5, 4.5];
  const rec = (f: (l: number) => ScorePred) => Object.fromEntries(lines.map((l) => [l.toFixed(1), probWhere(m, f(l))]));
  return {
    home: probWhere(m, pred.home()), draw: probWhere(m, pred.draw()), away: probWhere(m, pred.away()),
    dc1X: probWhere(m, pred.dc1X()), dcX2: probWhere(m, pred.dcX2()), dc12: probWhere(m, pred.dc12()),
    btts: probWhere(m, pred.btts()),
    over: rec(pred.over), homeOver: rec(pred.homeOver), awayOver: rec(pred.awayOver),
  };
}
