import { buildModelBank } from '../stages/poisson/modelBank';
import { generate } from './generate';

/**
 * Generate from the command line (development and testing; runs on the server machine):
 *   npm run generate -- <tickets> <matches> [--simple] [--no-ai]
 * --simple: one selection per match; otherwise a combination of 2-4 per match.
 */
async function main() {
  const [tickets = '1', matches = '5'] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const ai = !process.argv.includes('--no-ai');
  const betType = process.argv.includes('--simple') ? 'simple' : 'combo';
  const t0 = Date.now();
  const bank = await buildModelBank();
  const res = await generate(bank, { tickets: Number(tickets), matches: Number(matches), betType, ai }, (l) => console.log(`  ${l}`));
  for (const tk of res.tickets) {
    console.log(`\n  TICKET ${tk.index} (${betType}): ${tk.matches.length} matches, total fair odds ${tk.fairOdds.toFixed(2)}, chance ${(tk.probability * 100).toFixed(1)}%`);
    for (const m of tk.matches) {
      console.log(`    ${m.fixture.home} v ${m.fixture.away} (${m.fixture.leagueName}, ${m.fixture.kickoff.slice(0, 16).replace('T', ' ')} UTC)` +
        ` — ${(m.adjusted * 100).toFixed(0)}% · fair ${m.fairOdds.toFixed(2)}`);
      for (const l of m.legs) console.log(`      - ${l.market}: ${l.pick} (${(l.probability * 100).toFixed(0)}%)`);
      if (m.explanation) console.log(`      ${m.explanation}`);
    }
  }
  console.log(`\n  ${((Date.now() - t0) / 1000).toFixed(0)} s${ai ? '' : ' (no AI)'}\n`);
}

main().catch((e) => { console.error(e?.message ?? e); process.exit(1); });
