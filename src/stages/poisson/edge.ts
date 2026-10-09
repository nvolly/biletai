/** Remove the margin from a complete set of market prices (proportional method). */
export function fairProbs(prices: number[]): number[] {
  const implied = prices.map((p) => 1 / p);
  const s = implied.reduce((a, b) => a + b, 0);
  return implied.map((x) => x / s);
}
