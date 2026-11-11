/**
 * The detached worker process (FEAT-064 TASK-012), built to `dist/worker.js`
 * and started only through `spawnDetachedWorker`. Not a `bin` entry.
 *
 * Usage: `node dist/worker.js --launch <absolute launch file>`.
 */

import { runWorker } from './worker/entry.js';

/** How long handles may keep the process alive after the result is written. */
const EXIT_BACKSTOP_MS = 5_000;

const code = await runWorker(process.argv.slice(2), {
  env: process.env,
  chdir: (path) => {
    process.chdir(path);
  },
});
process.exitCode = code;
// The entry, never a handler, hard-exits if something still holds the loop.
setTimeout(() => {
  process.exit(code);
}, EXIT_BACKSTOP_MS).unref();
