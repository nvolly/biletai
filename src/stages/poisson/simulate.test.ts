import { describe, it, expect } from '@jest/globals';
import { simulate, jointProbability, probability, goalInvolvementOutcome, latentOutcome, Outcome } from './simulate';
import { cholesky, identity, nearestCorrelation, VAR_INDEX, SIM_VARS } from './copula';
import { scoreMatrix } from './dixonColes';
import { jointProb, pred } from './markets';

const N = 40000;
const model = {
  goals: { lh: 1.6, la: 1.1, rho: -0.07, firstHalfShare: 0.45 },
  counts: { corners: { lh: 5.8, la: 4.4, dispersion: 1.3 }, cards: { lh: 2.1, la: 2.3, dispersion: 1.4 } },
};
// Standard error of a proportion at N = 40k is at most 0.0025; 4 SE tolerance.
const TOL = 0.01;

function outcome(sim: ReturnType<typeof simulate>, f: (i: number) => boolean): Outcome {
  const o = new Uint8Array(sim.n);
  for (let i = 0; i < sim.n; i++) o[i] = f(i) ? 1 : 0;
  return o;
}

describe('simulation reproduces the exact score matrix', () => {
  const sim = simulate(model, cholesky(identity(SIM_VARS.length)), N, 1);
  const m = scoreMatrix(1.6, 1.1, -0.07);

  it('matches single goals markets', () => {
    expect(probability(outcome(sim, (i) => sim.gh[i] > sim.ga[i]))).toBeCloseTo(jointProb(m, [pred.home()]), 1);
    expect(Math.abs(probability(outcome(sim, (i) => sim.gh[i] + sim.ga[i] > 2.5)) - jointProb(m, [pred.over(2.5)]))).toBeLessThan(TOL);
  });

  it('matches a goals-only combination (home win + BTTS + over 2.5)', () => {
    const legs = [
      outcome(sim, (i) => sim.gh[i] > sim.ga[i]),
      outcome(sim, (i) => sim.gh[i] > 0 && sim.ga[i] > 0),
      outcome(sim, (i) => sim.gh[i] + sim.ga[i] > 2.5),
    ];
    const exact = jointProb(m, [pred.home(), pred.btts(), pred.over(2.5)]);
    expect(Math.abs(jointProbability(legs) - exact)).toBeLessThan(TOL);
  });

  it('first-half goals never exceed full-time goals', () => {
    for (let i = 0; i < sim.n; i++) {
      expect(sim.gh1[i]).toBeLessThanOrEqual(sim.gh[i]);
      expect(sim.ga1[i]).toBeLessThanOrEqual(sim.ga[i]);
    }
  });

  it('keeps each count model mean', () => {
    const [ch, ca] = sim.counts.corners!;
    const mean = (a: Int16Array) => a.reduce((s, x) => s + x, 0) / a.length;
    expect(mean(ch)).toBeCloseTo(5.8, 0);
    expect(mean(ca)).toBeCloseTo(4.4, 0);
  });
});

describe('correlation across models', () => {
  const R = identity(SIM_VARS.length);
  const g = VAR_INDEX.goalsH, c = VAR_INDEX.cornersH;
  R[g][c] = R[c][g] = 0.5;
  const sim = simulate(model, cholesky(nearestCorrelation(R)), N, 2);

  it('positively correlated legs land together more often than the product', () => {
    const goals = outcome(sim, (i) => sim.gh[i] > 1.5);
    const corners = outcome(sim, (i) => sim.counts.corners![0][i] > 5.5);
    expect(jointProbability([goals, corners])).toBeGreaterThan(probability(goals) * probability(corners) + 0.02);
  });

  it('a joint probability never exceeds its least likely leg', () => {
    const legs = [
      outcome(sim, (i) => sim.gh[i] + sim.ga[i] > 1.5),
      outcome(sim, (i) => sim.counts.cards![0][i] + sim.counts.cards![1][i] > 3.5),
      outcome(sim, (i) => sim.counts.corners![0][i] > sim.counts.corners![1][i]),
    ];
    const j = jointProbability(legs);
    for (const l of legs) expect(j).toBeLessThanOrEqual(probability(l));
  });
});

describe('player legs', () => {
  const sim = simulate(model, cholesky(identity(SIM_VARS.length)), N, 3);

  it('goal involvement hits its target marginal and needs a team goal', () => {
    const o = goalInvolvementOutcome(sim, 'home', 0.35, 1, 9);
    expect(Math.abs(probability(o) - 0.35)).toBeLessThan(TOL);
    for (let i = 0; i < sim.n; i++) if (sim.gh[i] === 0) expect(o[i]).toBe(0);
  });

  it('latent legs hit their target marginal', () => {
    const o = latentOutcome(sim, ['shotsH'], 0.6, 0.5, 11);
    expect(Math.abs(probability(o) - 0.6)).toBeLessThan(TOL);
  });
});
