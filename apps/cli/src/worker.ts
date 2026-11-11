/**
 * The detached worker process (FEAT-064 TASK-012), built to `dist/worker.js`
 * and started only through `spawnDetachedWorker`. Not a `bin` entry.
 *
 * Usage: `node dist/worker.js --launch <absolute launch file>`.
 *
 * An app-host launch (FEAT-065) is gated by the invocation claim: a refused
 * claim exits 0 with no side effects, and a completed command records its
 * exit on the invocation.
 */

import { FileInvocationStore, currentProcessIdentity, runsRoot } from '@yantra/core';

import { invocationLifecycle } from './ui/worker-claim.js';
import { runWorker } from './worker/entry.js';

/** How long handles may keep the process alive after the result is written. */
const EXIT_BACKSTOP_MS = 5_000;

const lifecycle = invocationLifecycle({
  store: new FileInvocationStore(),
  identity: currentProcessIdentity,
  runsRoot: runsRoot(),
});
const code = await runWorker(process.argv.slice(2), {
  env: process.env,
  chdir: (path) => {
    process.chdir(path);
  },
  gate: lifecycle.gate,
});
await lifecycle.finish(code).catch(() => undefined);
process.exitCode = code;
// The entry, never a handler, hard-exits if something still holds the loop.
setTimeout(() => {
  process.exit(code);
}, EXIT_BACKSTOP_MS).unref();
