import { scoreMatrix } from './dixonColes';
import { probWhere, pred } from './markets';

/**
 * Expected goals implied by the market's own prices, so the model can be blended with them:
 *
 *     lambda = lambda_model ^ w  x  lambda_market ^ (1 - w)
 *
 * Blending the RATES (not the leg probabilities) keeps every market and every combination
 * consistent, because they are all still read from one simulated match. `w = 1` is the
 * pure model; the backtest reports log-loss per `w` so the weight is measured, not chosen.
 */
export function impliedGoalLambdas(fair: { home: number; away: number; over25?: number }, rho: number): [number, number] {
  // Without an Over/Under 2.5 price (feeds for smaller leagues carry 1X2 only), the home
  // and away win probabilities alone pin down both rates: the draw share fixes the total.
  const loss = (lh: number, la: number) => {
    const m = scoreMatrix(lh, la, rho);
    return (probWhere(m, pred.home()) - fair.home) ** 2 +
      (probWhere(m, pred.away()) - fair.away) ** 2 +
      (fair.over25 != null ? (probWhere(m, pred.over(2.5)) - fair.over25) ** 2 : 0);
  };
  let best: [number, number] = [1.4, 1.1], bestL = Infinity;
  for (let lh = 0.2; lh <= 4.5; lh += 0.1) for (let la = 0.2; la <= 4.5; la += 0.1) {
    const l = loss(lh, la);
    if (l < bestL) { bestL = l; best = [lh, la]; }
  }
  for (const step of [0.02, 0.005]) {
    const [ch, ca] = best;
    for (let lh = ch - 5 * step; lh <= ch + 5 * step; lh += step) for (let la = ca - 5 * step; la <= ca + 5 * step; la += step) {
      if (lh <= 0.05 || la <= 0.05) continue;
      const l = loss(lh, la);
      if (l < bestL) { bestL = l; best = [lh, la]; }
    }
  }
  return best;
}

export function blend(model: number, market: number | null | undefined, modelWeight: number): number {
  if (market == null || !(market > 0)) return model;
  return Math.exp(modelWeight * Math.log(model) + (1 - modelWeight) * Math.log(market));
}
