import { Worker } from 'node:worker_threads';
import { join, dirname } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { buildSync } from 'esbuild';
import { runSimulation, WorkerFixtureModel } from './simulateWorker';
import { StatKey } from './history';

/**
 * Monte Carlo over whole matches, so legs priced by DIFFERENT models (goals, corners,
 * cards, shots) can be combined honestly.
 *
 * Each simulated match draws one correlated normal vector z = L·e (L = Cholesky factor of
 * the copula), then turns every component into a count through its own model's marginal.
 * A combination's probability is the share of simulated matches in which every leg wins —
 * so "over 2.5 goals + over 9.5 corners" picks up the measured goals/corners correlation
 * instead of pretending the two are independent.
 *
 * Goals are drawn from the Dixon-Coles matrix itself (home from the row sums, away from
 * the chosen row), which reproduces the matrix exactly; the copula keeps home/away goals
 * mutually uncorrelated for that reason and only ties them to the other stats.
 *
 * The 20,000-run loop lives in simulateWorker.ts and is executed in a worker thread
 * (`simulateAsync`), so a generation no longer blocks the HTTP server. `simulate` runs
 * the same loop in the calling thread and stays available (e.g. in tests).
 */
export interface FixtureModel {
  goals: { lh: number; la: number; rho: number; firstHalfShare: number };
  counts: Partial<Record<StatKey, { lh: number; la: number; dispersion: number }>>;
}

export interface Simulation {
  n: number;
  gh: Int16Array; ga: Int16Array;     // full-time goals
  gh1: Int16Array; ga1: Int16Array;   // first-half goals
  counts: Partial<Record<StatKey, [Int16Array, Int16Array]>>;
  seed: number;
}

export function simulate(model: FixtureModel, chol: number[][], n: number, seed: number): Simulation {
  return runSimulation(model as WorkerFixtureModel, chol, n, seed);
}

interface WorkerReply {
  n: number; seed: number;
  gh: Int16Array; ga: Int16Array; gh1: Int16Array; ga1: Int16Array;
  counts?: Partial<Record<StatKey, [Int16Array, Int16Array]>>;
  err?: string;
}

/**
 * Bundle the worker into a self-contained CommonJS .js so it can start under the stock
 * Node loader (no tsx needed inside the worker thread). Recompiles only when the source
 * or one of its imports changes; the cache lives in the module's own directory.
 */
function workerScriptPath(): string {
  const src = join(__dirname, 'simulateWorker.ts');
  const out = join(__dirname, 'simulateWorker.bundle.js');
  const stamp = join(__dirname, 'simulateWorker.bundle.stamp');
  const sources = [
    src,
    join(__dirname, 'dixonColes.ts'),
    join(__dirname, 'distributions.ts'),
    join(__dirname, 'copula.ts'),
  ].map((p) => readFileSync(p, 'utf8')).join('\n---\n');
  try {
    if (readFileSync(stamp, 'utf8') === sources) return out;
  } catch { /* missing or stale, compile below */ }
  mkdirSync(__dirname, { recursive: true });
  buildSync({
    entryPoints: [src],
    outfile: out,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    sourcemap: false,
    logLevel: 'silent',
  });
  writeFileSync(stamp, sources);
  return out;
}

/** Single-flight queue: at most one simulation in the worker at a time. */
let worker: Worker | null = null;
let workerReady: Promise<Worker> | null = null;
let tail: Promise<unknown> = Promise.resolve();

function getWorker(): Promise<Worker> {
  if (worker || workerReady) return (workerReady as Promise<Worker>);
  workerReady = new Promise<Worker>((resolve, reject) => {
    let settled = false;
    const fail = (err: Error): void => { if (!settled) { settled = true; workerReady = null; reject(err); } else if (worker) { worker = null; workerReady = null; } };
    try {
      const w = new Worker(workerScriptPath());
      w.unref();
      w.once('online', () => { if (!settled) { settled = true; worker = w; resolve(w); } });
      w.once('error', fail);
      w.on('exit', () => { if (worker === w) { worker = null; workerReady = null; } });
    } catch (err) {
      fail(err instanceof Error ? err : new Error(String(err)));
    }
  });
  return workerReady;
}

/** Same inputs and seed as {@link simulate}, but the loop runs in a worker thread. */
export async function simulateAsync(model: FixtureModel, chol: number[][], n: number, seed: number): Promise<Simulation> {
  const step = async (): Promise<Simulation> => {
    const w = await getWorker();
    return new Promise<Simulation>((resolve, reject) => {
      const onMessage = (msg: WorkerReply): void => {
        w.off('message', onMessage);
        if (msg.err !== undefined) reject(new Error(msg.err));
        else resolve({ n: msg.n, seed: msg.seed, gh: msg.gh, ga: msg.ga, gh1: msg.gh1, ga1: msg.ga1, counts: msg.counts ?? {} });
      };
      w.on('message', onMessage);
      w.once('error', (err: Error) => reject(err));
      w.postMessage({ model, chol, n, seed });
    });
  };
  const p = tail.then(step, step);
  tail = p.catch(() => {});
  return p;
}

export type Outcome = Uint8Array;

export function probability(o: Outcome): number {
  let k = 0;
  for (let i = 0; i < o.length; i++) k += o[i];
  return k / o.length;
}

/** P(every leg wins) — the share of simulated matches where all outcomes are 1. */
export function jointProbability(outcomes: Outcome[]): number {
  if (!outcomes.length) return 0;
  const n = outcomes[0].length;
  let k = 0;
  outer: for (let i = 0; i < n; i++) {
    for (const o of outcomes) if (!o[i]) continue outer;
    k++;
  }
  return k / n;
}
