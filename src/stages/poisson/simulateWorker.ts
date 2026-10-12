import { parentPort, isMainThread, Transferable } from 'node:worker_threads';
import { StatKey } from './history';
import { scoreMatrix } from './dixonColes';
import { countTable, gaussian, normCdf, quantileFromTable, rng } from './distributions';
import { SIM_VARS, STAT_VARS, VAR_INDEX } from './copula';

export interface WorkerFixtureModel {
  goals: { lh: number; la: number; rho: number; firstHalfShare: number };
  counts: Partial<Record<StatKey, { lh: number; la: number; dispersion: number }>>;
}

/**
 * The heavy loop of the match simulation, run in a worker thread so the HTTP server
 * stays responsive. Must produce bit-identical results to the same input and seed —
 * it is the only place in the codebase that draws from the seeded PRNG.
 *
 * Every array in the result owns exactly one backing ArrayBuffer, so the whole result
 * can be shipped back to the main thread by transferring those buffers (no copy).
 */
export function runSimulation(model: WorkerFixtureModel, chol: number[][], n: number, seed: number) {
  const rand = rng(seed);
  const d = SIM_VARS.length;
  const matrix = scoreMatrix(model.goals.lh, model.goals.la, model.goals.rho);
  const rowTotals = matrix.map((r) => r.reduce((a, b) => a + b, 0));
  const condRows = matrix.map((r, i) => r.map((x) => (rowTotals[i] > 0 ? x / rowTotals[i] : 0)));

  const MAX_COUNT: Record<StatKey, number> = { shots: 60, sot: 30, corners: 30, cards: 20, reds: 6 };
  const tables: Record<string, Float64Array> = {};
  for (const [stat, m] of Object.entries(model.counts) as [StatKey, { lh: number; la: number; dispersion: number }][]) {
    const [vh, va] = STAT_VARS[stat];
    tables[vh] = countTable(m.lh, m.dispersion, MAX_COUNT[stat]);
    tables[va] = countTable(m.la, m.dispersion, MAX_COUNT[stat]);
  }

  const stats = Object.keys(model.counts) as StatKey[];
  const sim = {
    n, seed,
    gh: new Int16Array(n), ga: new Int16Array(n), gh1: new Int16Array(n), ga1: new Int16Array(n),
    counts: Object.fromEntries(stats.map((s) => [s, [new Int16Array(n), new Int16Array(n)]])) as Partial<Record<StatKey, [Int16Array, Int16Array]>>,
  };

  const e = new Float64Array(d), z = new Float64Array(d);
  const share = model.goals.firstHalfShare;
  for (let s = 0; s < n; s++) {
    for (let i = 0; i < d; i++) e[i] = gaussian(rand);
    for (let i = 0; i < d; i++) {
      let acc = 0;
      for (let k = 0; k <= i; k++) acc += chol[i][k] * e[k];
      z[i] = acc;
    }

    const h = quantileFromTable(rowTotals, normCdf(z[VAR_INDEX.goalsH]));
    const a = quantileFromTable(condRows[h], normCdf(z[VAR_INDEX.goalsA]));
    sim.gh[s] = h; sim.ga[s] = a;
    // Each goal independently falls in the first half with the league's measured share.
    let h1 = 0, a1 = 0;
    for (let g = 0; g < h; g++) if (rand() < share) h1++;
    for (let g = 0; g < a; g++) if (rand() < share) a1++;
    sim.gh1[s] = h1; sim.ga1[s] = a1;

    for (const stat of stats) {
      const [vh, va] = STAT_VARS[stat];
      sim.counts[stat]![0][s] = quantileFromTable(tables[vh], normCdf(z[VAR_INDEX[vh]]));
      sim.counts[stat]![1][s] = quantileFromTable(tables[va], normCdf(z[VAR_INDEX[va]]));
    }
  }
  return sim;
}

/** The result message the worker posts back; arrays ride in the transferred buffers. */
export interface WorkerResult {
  n: number; seed: number;
  gh: Int16Array; ga: Int16Array; gh1: Int16Array; ga1: Int16Array;
  counts: Partial<Record<StatKey, [Int16Array, Int16Array]>>;
  err?: never;
}

const BUFFERS_OF: (s: ReturnType<typeof runSimulation>) => Transferable[] = (s) => [
  s.gh.buffer, s.ga.buffer, s.gh1.buffer, s.ga1.buffer,
  ...Object.values(s.counts).map(([a, b]) => [a.buffer, b.buffer]).flat(),
] as Transferable[];

/**
 * Also the worker script. `simulate.ts` imports the function above from this file, and
 * when it is re-run inside a worker_threads Worker (via tsx) it serves one request per
 * message and posts the result back, transferring the backing buffers.
 */
if (!isMainThread) {
  parentPort!.on('message', (msg: { model: WorkerFixtureModel; chol: number[][]; n: number; seed: number }) => {
    try {
      const sim = runSimulation(msg.model, msg.chol, msg.n, msg.seed);
      parentPort!.postMessage({ n: sim.n, seed: sim.seed, gh: sim.gh, ga: sim.ga, gh1: sim.gh1, ga1: sim.ga1, counts: sim.counts }, BUFFERS_OF(sim));
    } catch (err) {
      parentPort!.postMessage({ err: err instanceof Error ? err.message : String(err) });
    }
  });
}
