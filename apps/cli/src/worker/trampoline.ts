/**
 * The worker trampoline (FEAT-064 TASK-012, spike S2 RC1).
 *
 * `spawnDetachedWorker` starts this short-lived process, which starts the real
 * worker detached, writes the worker's PID on stdout, and exits at once. The
 * worker's parent is then a dead process, so a process-tree kill of the host
 * (`taskkill /T`, Task Manager's "End process tree") cannot reach it, and on
 * POSIX the worker leads its own session, so a process-group kill misses it.
 *
 * Usage: `node trampoline.js <node> <worker.js> --launch <abs path>`.
 */

import { spawn } from 'node:child_process';

import { WORKER_SPAWN_OPTIONS } from './spawn-options.js';

const [nodePath, workerPath, ...rest] = process.argv.slice(2);
if (nodePath === undefined || workerPath === undefined) {
  process.exitCode = 1;
} else {
  const child = spawn(nodePath, [workerPath, ...rest], {
    ...WORKER_SPAWN_OPTIONS,
    cwd: process.cwd(),
    env: process.env,
  });
  child.unref();
  if (child.pid === undefined) {
    process.exitCode = 1;
  } else {
    process.stdout.write(`${child.pid}\n`);
  }
}
