/**
 * Launch-ownership evidence worker (FEAT-065 TASK-019). Test fixture only.
 *
 * The real FEAT-064 worker entry (`runWorker`) with the real app-launch claim
 * lifecycle, running a fixture command instead of a registry handler: it
 * claims its run's lease exclusively (as a run owner does), writes one marker
 * file per execution, works for a while, and exits. A second owner of the
 * same run (two `resume`s) loses the lease and ends with exit 3 (busy).
 *
 * Fault points (YANTRA_TEST_FAULT, compiled only into this fixture):
 *   worker:delay-claim  wait 1.5 s before claiming
 *   worker:delay-lease  wait 1.5 s after claiming, before taking the lease
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  FileInvocationStore,
  currentProcessIdentity,
  runsRoot,
  writeFileAtomic,
} from '@yantra/core';

import { invocationLifecycle } from '../../../../dist/ui/worker-claim.js';
import { runWorker } from '../../../../dist/worker/entry.js';

const fault = process.env.YANTRA_TEST_FAULT ?? '';
const markers = process.env.YANTRA_TEST_MARKERS ?? '';
const workMs = Number(process.env.YANTRA_TEST_WORK_MS ?? '800');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const lifecycle = invocationLifecycle({
  store: new FileInvocationStore(),
  identity: currentProcessIdentity,
  runsRoot: runsRoot(),
  pollMs: 50,
});

async function gate(launch) {
  if (fault.includes('worker:delay-claim')) await sleep(1500);
  return lifecycle.gate(launch);
}

async function run(invocation) {
  const me = await currentProcessIdentity();
  if (fault.includes('worker:delay-lease')) await sleep(1500);
  const runId =
    invocation.path[0] === 'resume' ? invocation.argv[0] : `fixture-${invocation.invocation_id}`;
  const runDir = join(runsRoot(), runId);
  await mkdir(runDir, { recursive: true });
  const lease = {
    schema_version: 1,
    run_id: runId,
    owner: { pid: me.pid, start_token: me.startToken },
    origin: 'worker',
    execution_class: 'run',
    command: [...invocation.path],
    socket: { kind: 'unix', address: `/tmp/yantra-fixture/${'a'.repeat(24)}.sock` },
    run_token: 'Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4cXV1eHF1dXg',
    channel_version: 1,
    yantra_version: '0.0.0',
    log_seq_at_claim: 0,
    claimed_at: new Date().toISOString(),
  };
  try {
    await writeFileAtomic(join(runDir, 'lease.json'), JSON.stringify(lease), { exclusive: true });
  } catch (error) {
    if (error.code === 'EEXIST')
      return { type: 'result', exit_code: 3, envelope: null, text: 'busy' };
    throw error;
  }
  await writeFile(join(markers, `${invocation.invocation_id}.${process.pid}`), runId);
  await sleep(workMs);
  return { type: 'result', exit_code: 0, envelope: null, text: null };
}

const code = await runWorker(process.argv.slice(2), {
  env: process.env,
  chdir: (path) => {
    process.chdir(path);
  },
  gate,
  run,
});
await lifecycle.finish(code).catch(() => undefined);
process.exitCode = code;
