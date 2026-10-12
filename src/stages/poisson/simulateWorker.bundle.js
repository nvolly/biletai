"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/stages/poisson/simulateWorker.ts
var simulateWorker_exports = {};
__export(simulateWorker_exports, {
  runSimulation: () => runSimulation
});
module.exports = __toCommonJS(simulateWorker_exports);
var import_node_worker_threads = require("node:worker_threads");

// src/stages/poisson/distributions.ts
function poissonPmf(lambda, k) {
  if (k < 0) return 0;
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let logP = -lambda + k * Math.log(lambda);
  for (let i = 2; i <= k; i++) logP -= Math.log(i);
  return Math.exp(logP);
}
function logGamma(x) {
  const g = 7;
  const c = [
    0.9999999999998099,
    676.5203681218851,
    -1259.1392167224028,
    771.3234287776531,
    -176.6150291621406,
    12.507343278686905,
    -0.13857109526572012,
    9984369578019572e-21,
    15056327351493116e-23
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}
function negBinPmf(mean, dispersion, k) {
  if (dispersion <= 1.0001) return poissonPmf(mean, k);
  if (k < 0) return 0;
  const p = 1 / dispersion;
  const r = mean / (dispersion - 1);
  return Math.exp(logGamma(k + r) - logGamma(k + 1) - logGamma(r) + r * Math.log(p) + k * Math.log(1 - p));
}
function countTable(mean, dispersion, max) {
  const t = new Float64Array(max + 1);
  let s = 0;
  for (let k = 0; k < max; k++) {
    t[k] = negBinPmf(mean, dispersion, k);
    s += t[k];
  }
  t[max] = Math.max(0, 1 - s);
  return t;
}
function quantileFromTable(table, u) {
  let c = 0;
  for (let k = 0; k < table.length; k++) {
    c += table[k];
    if (u <= c) return k;
  }
  return table.length - 1;
}
function normCdf(z) {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = s + 1831565813 >>> 0;
    let t = s;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function gaussian(rand) {
  let u = 0;
  while (u === 0) u = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

// src/stages/poisson/dixonColes.ts
var MAX_GOALS = 10;
function tau(h, a, lh, la, rho) {
  if (h === 0 && a === 0) return 1 - lh * la * rho;
  if (h === 0 && a === 1) return 1 + lh * rho;
  if (h === 1 && a === 0) return 1 + la * rho;
  if (h === 1 && a === 1) return 1 - rho;
  return 1;
}
function rhoBounds(lh, la) {
  const lo = Math.max(-1 / Math.max(lh, 1e-9), -1 / Math.max(la, 1e-9));
  const hi = Math.min(1 / Math.max(lh * la, 1e-9), 1);
  return [lo, hi];
}
function scoreMatrix(lh, la, rho) {
  const [lo, hi] = rhoBounds(lh, la);
  const r = Math.min(hi, Math.max(lo, rho));
  const ph = Array.from({ length: MAX_GOALS + 1 }, (_, k) => poissonPmf(lh, k));
  const pa = Array.from({ length: MAX_GOALS + 1 }, (_, k) => poissonPmf(la, k));
  const m = [];
  let total = 0;
  for (let h = 0; h <= MAX_GOALS; h++) {
    m[h] = [];
    for (let a = 0; a <= MAX_GOALS; a++) {
      m[h][a] = ph[h] * pa[a] * tau(h, a, lh, la, r);
      total += m[h][a];
    }
  }
  for (let h = 0; h <= MAX_GOALS; h++) for (let a = 0; a <= MAX_GOALS; a++) m[h][a] /= total;
  return m;
}

// src/stages/poisson/copula.ts
var SIM_VARS = [
  "goalsH",
  "goalsA",
  "shotsH",
  "shotsA",
  "sotH",
  "sotA",
  "cornersH",
  "cornersA",
  "cardsH",
  "cardsA",
  "redsH",
  "redsA"
];
var VAR_INDEX = Object.fromEntries(SIM_VARS.map((v, i) => [v, i]));
var STAT_VARS = {
  shots: ["shotsH", "shotsA"],
  sot: ["sotH", "sotA"],
  corners: ["cornersH", "cornersA"],
  cards: ["cardsH", "cardsA"],
  reds: ["redsH", "redsA"]
};

// src/stages/poisson/simulateWorker.ts
function runSimulation(model, chol, n, seed) {
  const rand = rng(seed);
  const d = SIM_VARS.length;
  const matrix = scoreMatrix(model.goals.lh, model.goals.la, model.goals.rho);
  const rowTotals = matrix.map((r) => r.reduce((a, b) => a + b, 0));
  const condRows = matrix.map((r, i) => r.map((x) => rowTotals[i] > 0 ? x / rowTotals[i] : 0));
  const MAX_COUNT = { shots: 60, sot: 30, corners: 30, cards: 20, reds: 6 };
  const tables = {};
  for (const [stat, m] of Object.entries(model.counts)) {
    const [vh, va] = STAT_VARS[stat];
    tables[vh] = countTable(m.lh, m.dispersion, MAX_COUNT[stat]);
    tables[va] = countTable(m.la, m.dispersion, MAX_COUNT[stat]);
  }
  const stats = Object.keys(model.counts);
  const sim = {
    n,
    seed,
    gh: new Int16Array(n),
    ga: new Int16Array(n),
    gh1: new Int16Array(n),
    ga1: new Int16Array(n),
    counts: Object.fromEntries(stats.map((s) => [s, [new Int16Array(n), new Int16Array(n)]]))
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
    sim.gh[s] = h;
    sim.ga[s] = a;
    let h1 = 0, a1 = 0;
    for (let g = 0; g < h; g++) if (rand() < share) h1++;
    for (let g = 0; g < a; g++) if (rand() < share) a1++;
    sim.gh1[s] = h1;
    sim.ga1[s] = a1;
    for (const stat of stats) {
      const [vh, va] = STAT_VARS[stat];
      sim.counts[stat][0][s] = quantileFromTable(tables[vh], normCdf(z[VAR_INDEX[vh]]));
      sim.counts[stat][1][s] = quantileFromTable(tables[va], normCdf(z[VAR_INDEX[va]]));
    }
  }
  return sim;
}
var BUFFERS_OF = (s) => [
  s.gh.buffer,
  s.ga.buffer,
  s.gh1.buffer,
  s.ga1.buffer,
  ...Object.values(s.counts).map(([a, b]) => [a.buffer, b.buffer]).flat()
];
if (!import_node_worker_threads.isMainThread) {
  import_node_worker_threads.parentPort.on("message", (msg) => {
    try {
      const sim = runSimulation(msg.model, msg.chol, msg.n, msg.seed);
      import_node_worker_threads.parentPort.postMessage({ n: sim.n, seed: sim.seed, gh: sim.gh, ga: sim.ga, gh1: sim.gh1, ga1: sim.ga1, counts: sim.counts }, BUFFERS_OF(sim));
    } catch (err) {
      import_node_worker_threads.parentPort.postMessage({ err: err instanceof Error ? err.message : String(err) });
    }
  });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  runSimulation
});
