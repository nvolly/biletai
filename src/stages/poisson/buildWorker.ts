import { buildSync } from 'esbuild';
import { join, dirname } from 'node:path';

/** Build the worker bundle (run as `npx tsx src/stages/poisson/buildWorker.ts`). */
const dir = dirname(__filename);
buildSync({
  entryPoints: [join(dir, 'simulateWorker.ts')],
  outfile: join(dir, 'simulateWorker.bundle.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: false,
  logLevel: 'silent',
});
