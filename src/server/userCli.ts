import { settings } from '../config/config';
import { readCosts } from '../utils/costMeter';
import { activePlan, addCredits, createUser, isPaused, listUsers, planLeft, pause, rotateKey, setPlan } from './accounts';

/**
 * Server-side user admin (run on the server):
 *   npm run user -- add <email> [credits]     create a user, print the access key ONCE
 *   npm run user -- credit <email> <n>        add (or with a negative n remove) top-up credits
 *   npm run user -- plan <email> <id> [months] give a plan (start | pro | max | topup10)
 *   npm run user -- key <email>               issue a new access key (old one stops working)
 *   npm run user -- pause <email> <days>      block generations for 1, 7 or 30 days (0 lifts it)
 *   npm run user -- list
 *   npm run user -- costs                     what generations and questions really cost
 */
const [cmd, a, b, c] = process.argv.slice(2);

/** Average real cost per generation / question / request, and what it means for each plan. */
function costReport() {
  const all = readCosts();
  if (!all.length) { console.log('  no costs logged yet (data/costs.jsonl)'); return; }
  const ron = settings.costs.usdToRon;
  const lei = (usd: number) => `${(usd * ron).toFixed(3)} lei ($${usd.toFixed(4)})`;
  console.log(`\n  ${all.length} logged units, ${all[0].at.slice(0, 10)} … ${all[all.length - 1].at.slice(0, 10)}`);
  const avg: Record<string, number> = {};
  for (const kind of ['generation', 'ask', 'parse'] as const) {
    const xs = all.filter((e) => e.kind === kind);
    if (!xs.length) continue;
    const sum = xs.reduce((s, e) => s + e.usd, 0);
    avg[kind] = sum / xs.length;
    const u = xs.reduce((s, e) => ({ ds: s.ds + e.usage.deepseekCalls, ws: s.ws + e.usage.webSearches, jev: s.jev + e.usage.jevCalls }), { ds: 0, ws: 0, jev: 0 });
    console.log(`  ${kind.padEnd(10)} n=${String(xs.length).padEnd(4)} avg ${lei(avg[kind])}  total ${lei(sum)}` +
      `  · per unit: ${(u.ds / xs.length).toFixed(1)} DeepSeek calls, ${(u.ws / xs.length).toFixed(1)} searches, ${(u.jev / xs.length).toFixed(1)} Jev calls`);
  }
  const gen = all.filter((e) => e.kind === 'generation' && e.matches);
  if (gen.length) console.log(`  per match on a ticket: ${lei(gen.reduce((s, e) => s + e.usd, 0) / gen.reduce((s, e) => s + (e.matches ?? 0), 0))}`);
  // Each plan if fully used: what's left after VAT (21%), the store's cut (15%) and the AI.
  const g = avg.generation ?? 0, q = avg.ask ?? 0;
  console.log('\n  plan        price   kept*    AI if fully used   left');
  for (const p of settings.plans) {
    const kept = (p.priceRon / 1.21) * 0.85;
    const ai = p.generations * (g + q * p.questions) * ron;
    console.log(`  ${p.name.padEnd(11)} ${String(p.priceRon).padStart(3)} lei  ${kept.toFixed(1).padStart(5)}   ${ai.toFixed(2).padStart(8)} lei      ${(kept - ai).toFixed(1)} lei (${(((kept - ai) / kept) * 100).toFixed(0)}%)`);
  }
  console.log('  * after 21% VAT and a 15% store commission; every question used\n');
}

try {
  if (cmd === 'add' && a) {
    const { user, accessKey } = createUser(a, Number(b ?? 0));
    console.log(`\n  user ${user.email}: ${user.freeLeft} free + ${user.credits} paid generations`);
    console.log(`  ACCESS KEY (shown once, give it to the user): ${accessKey}\n`);
  } else if (cmd === 'credit' && a && b) {
    const u = addCredits(a, Number(b));
    console.log(`  ${u.email}: ${u.freeLeft} free + ${u.credits} paid generations`);
  } else if (cmd === 'plan' && a && b) {
    const u = setPlan(a, b, Number(c ?? 1));
    const p = activePlan(u);
    console.log(`  ${u.email}: ${p ? `${p.def.name} until ${p.until.slice(0, 10)}, ${planLeft(u)} left this month` : 'no monthly plan'} · ${u.freeLeft} free · ${u.credits} top-up`);
  } else if (cmd === 'key' && a) {
    console.log(`  NEW ACCESS KEY for ${a} (shown once): ${rotateKey(a)}`);
  } else if (cmd === 'pause' && a && b) {
    const u = pause(a, Number(b));
    console.log(`  ${u.email}: ${isPaused(u) ? `paused until ${u.pausedUntil!.slice(0, 10)}` : 'pause lifted'}`);
  } else if (cmd === 'list') {
    for (const u of listUsers()) {
      const p = activePlan(u);
      console.log(`  ${u.email.padEnd(32)} free ${u.freeLeft}  top-up ${u.credits}  plan ${p ? `${p.def.name} (${planLeft(u)} left)` : '-'}  used ${u.used}  since ${u.createdAt.slice(0, 10)}${isPaused(u) ? `  PAUSED until ${u.pausedUntil!.slice(0, 10)}` : ''}`);
    }
  } else if (cmd === 'costs') {
    costReport();
  } else {
    console.log('usage: npm run user -- add <email> [credits] | credit <email> <n> | plan <email> <id> [months] | key <email> | pause <email> <days> | list | costs');
    process.exit(1);
  }
} catch (e: any) {
  console.error(`  ${e.message}`);
  process.exit(1);
}
