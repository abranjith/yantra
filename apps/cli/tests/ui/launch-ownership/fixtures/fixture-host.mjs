/**
 * Launch-ownership evidence host (FEAT-065 TASK-019). Test fixture only.
 *
 * The real, compiled app host runtime, started as its own process, whose
 * workers are `fixture-worker.mjs` started through the real FEAT-064
 * `spawnDetachedWorker`. Prints `{"ready":true,"port":…,"pid":…}` once ready.
 *
 * Fault points (YANTRA_TEST_FAULT, compiled only into this fixture); each
 * kills the host process on the spot (no cleanup runs):
 *   host:before-spawn     after markSpawning, before the worker starts
 *   host:after-spawn      right after the worker starts, before its claim
 *   host:after-claim      once the worker has claimed, before its lease
 *   host:after-complete   once the worker finished, before the RPC response
 */

import { URL, fileURLToPath } from 'node:url';

import {
  FileInvocationStore,
  currentProcessIdentity,
  workerLaunchRoot,
  yantraVersion,
} from '@yantra/core';

import { startHostRuntime } from '../../../../dist/ui/host/host-runtime.js';
import { spawnDetachedWorker } from '../../../../dist/worker/spawn.js';

const fault = process.env.YANTRA_TEST_FAULT ?? '';
const workerPath = fileURLToPath(new URL('./fixture-worker.mjs', import.meta.url));
const store = new FileInvocationStore();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(id, states) {
  for (;;) {
    const record = await store.get(id);
    if (record !== null && states.includes(record.state)) return;
    await sleep(25);
  }
}

const host = await startHostRuntime({
  assetsRoot: process.env.YANTRA_UI_ASSETS_DIR ?? '',
  identity: await currentProcessIdentity(),
  yantraVersion: yantraVersion(),
  env: process.env,
  supervisor: {
    spawn: async (launch) => {
      const id = launch.invocation.invocation_id;
      if (fault.includes('host:before-spawn')) process.exit(9);
      const spawned = await spawnDetachedWorker({
        launch,
        launchDir: workerLaunchRoot(),
        env: process.env,
        workerPath,
      });
      process.stdout.write(`${JSON.stringify({ worker: spawned.pid, id })}\n`);
      if (fault.includes('host:after-spawn')) process.exit(9);
      if (fault.includes('host:after-claim')) {
        await until(id, ['claimed', 'running', 'finished']);
        process.exit(9);
      }
      if (fault.includes('host:after-complete')) {
        await until(id, ['finished']);
        process.exit(9);
      }
      return spawned;
    },
  },
});
process.stdout.write(`${JSON.stringify({ ready: true, port: host.port, pid: process.pid })}\n`);
