const {
  execFileSync,
} = require('node:child_process');
const {
  join,
} = require('node:path');

/** Build the simulation worker bundle so tests can run it under the stock Node loader. */
module.exports = function globalSetup() {
  execFileSync(process.execPath, [
    join(__dirname, 'node_modules/tsx/dist/cli.mjs'),
    join(__dirname, 'src/stages/poisson/buildWorker.ts'),
  ], { stdio: 'pipe' });
};
