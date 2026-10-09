/**
 * Value of a price: edge = P(every leg wins) x the offered price - 1 (used to compare the
 * model with a market price). P is the JOINT probability from the simulation.
 */
export function slipEdge(jointProbability: number, combinedOdds: number): number {
  if (!(jointProbability >= 0 && jointProbability <= 1)) throw new Error(`invalid probability ${jointProbability}`);
  if (!(combinedOdds > 1)) throw new Error(`invalid odds ${combinedOdds}`);
  return jointProbability * combinedOdds - 1;
}

export function passesEdge(jointProbability: number, combinedOdds: number, minEdge: number): boolean {
  return slipEdge(jointProbability, combinedOdds) >= minEdge - 1e-9; // 0.7 x 1.5 - 1 is 0.04999...
}

/** Remove the margin from a complete set of market prices (proportional method). */
export function fairProbs(prices: number[]): number[] {
  const implied = prices.map((p) => 1 / p);
  const s = implied.reduce((a, b) => a + b, 0);
  return implied.map((x) => x / s);
}
