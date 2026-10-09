import { Simulation } from '../stages/poisson/simulate';
import { Selection } from './catalogue';

/**
 * The best combination of selections on ONE match (a "builder"), read straight off the
 * simulation. Its fair odds are 1 / P(all selections win): no bookmaker price is involved.
 *
 * Beam search over the candidate selections, at most one per market family. A selection
 * must lower the joint probability by at least `MIN_INFO` (relative); one that barely moves
 * it (e.g. "over 0.5 goals" next to "home over 1.5") only pads the leg count.
 */
export interface Leg { id: string; family: string; market: string; pick: string; probability: number }
export interface Builder { legs: Leg[]; probability: number; fairOdds: number }

export interface BuilderOptions {
  minLegs: number;
  maxLegs: number;
  minOdds: number;      // fair odds band of the whole combination
  maxOdds: number;
  legMinOdds: number;   // skip selections more likely than 1 / legMinOdds
  maxCandidateLegs: number;
  beamWidth: number;
}

const MIN_INFO = 0.02;

interface Cand { sel: Selection; bits: Uint32Array; p: number }
interface Partial { legs: Cand[]; bits: Uint32Array; p: number }

function pack(s: Simulation, sel: Selection): Uint32Array {
  const w = new Uint32Array(Math.ceil(s.n / 32));
  for (let i = 0; i < s.n; i++) if (sel.test(s, i)) w[i >>> 5] |= 1 << (i & 31);
  return w;
}

function popcount(x: number): number {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
}

function and(a: Uint32Array, b: Uint32Array): { bits: Uint32Array; k: number } {
  const bits = new Uint32Array(a.length);
  let k = 0;
  for (let i = 0; i < a.length; i++) { bits[i] = a[i] & b[i]; k += popcount(bits[i]); }
  return { bits, k };
}

/** Candidate selections with their simulated probability, the likeliest first. */
export function candidates(sim: Simulation, sels: Selection[], available: Set<string>, opts: BuilderOptions): Cand[] {
  const out: Cand[] = [];
  for (const sel of sels) {
    if (!sel.needs.every((n) => available.has(n))) continue;
    const bits = pack(sim, sel);
    let k = 0;
    for (let i = 0; i < bits.length; i++) k += popcount(bits[i]);
    const p = k / sim.n;
    // Too likely to matter, or alone already beyond the band's longest odds.
    if (p >= 1 / opts.legMinOdds || p <= 1 / opts.maxOdds) continue;
    out.push({ sel, bits, p });
  }
  return out.sort((a, b) => b.p - a.p).slice(0, opts.maxCandidateLegs);
}

/** Up to `limit` builders inside the odds band, likeliest first. */
export function buildBest(sim: Simulation, pool: Cand[], opts: BuilderOptions, limit = 3): Builder[] {
  const n = sim.n;
  const found = new Map<string, Builder>();
  const key = (legs: Cand[]) => legs.map((l) => l.sel.id).sort().join('|');
  const lo = 1 / opts.maxOdds, hi = 1 / opts.minOdds; // probability band

  const consider = (p: Partial) => {
    if (p.legs.length < opts.minLegs || p.p < lo || p.p > hi) return;
    found.set(key(p.legs), {
      legs: p.legs.map((c) => ({ id: c.sel.id, family: c.sel.family, market: c.sel.market, pick: c.sel.pick, probability: c.p })),
      probability: p.p, fairOdds: 1 / p.p,
    });
  };

  let beam: Partial[] = pool.map((c) => ({ legs: [c], bits: c.bits, p: c.p }));
  beam.forEach(consider);
  for (let size = 2; size <= opts.maxLegs && beam.length; size++) {
    const next = new Map<string, Partial>();
    for (const partial of beam) {
      const used = new Set(partial.legs.map((l) => l.sel.family));
      for (const c of pool) {
        if (used.has(c.sel.family)) continue;
        const legs = [...partial.legs, c];
        const k = key(legs);
        if (next.has(k)) continue;
        const { bits, k: wins } = and(partial.bits, c.bits);
        const p = wins / n;
        if (p < lo) continue;                              // only gets less likely from here
        if (p > partial.p * (1 - MIN_INFO)) continue;      // padding, not information
        const cand = { legs, bits, p };
        next.set(k, cand);
        consider(cand);
      }
    }
    // Keep the likeliest partials, plus the ones nearest the band, so short-odds and
    // band-filling paths both survive.
    const all = [...next.values()];
    const byP = [...all].sort((a, b) => b.p - a.p).slice(0, opts.beamWidth);
    const byBand = [...all].sort((a, b) => Math.abs(a.p - hi) - Math.abs(b.p - hi)).slice(0, opts.beamWidth);
    beam = [...new Map([...byP, ...byBand].map((x) => [key(x.legs), x])).values()];
  }
  return [...found.values()].sort((a, b) => b.probability - a.probability || a.legs.length - b.legs.length).slice(0, limit);
}
