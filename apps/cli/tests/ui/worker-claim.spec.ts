// @no-llm
/**
 * The worker's app-launch path (FEAT-065 TASK-015): claim first, find the
 * owned run, record the exit; a refused claim does nothing at all.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileInvocationStore, resetPathCache, type ProcessIdentity } from '@yantra/core';
import type { InvocationRecordInput, WorkerLaunch } from '@yantra/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { claimInvocation, findOwnedRun, invocationLifecycle } from '../../src/ui/worker-claim.js';
import { runWorker } from '../../src/worker/entry.js';

const CWD = process.platform === 'win32' ? 'C:\\work' : '/work';
const ID = '01JD2X7Q8R9S0T1V2W3X000001';
const ME: ProcessIdentity = { pid: 4242, startToken: 'me' };
const TOKEN = 'Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4cXV1eHF1dXg';

let home: string;
let previousHome: string | undefined;
let store: FileInvocationStore;
let runs: string;

function record(): InvocationRecordInput {
  return {
    schema_version: 1,
    invocation_id: ID,
    invocation: { invocation_id: ID, path: ['research'], argv: ['--no-llm', 'q'], cwd: CWD },
    execution_class: 'run',
    state: 'queued',
    queued_at: '2026-11-11T10:00:00.000Z',
    updated_at: '2026-11-11T10:00:00.000Z',
    displayed_effective: { settings: [], content: [] },
    run_id: null,
    worker: null,
    review: null,
    result: null,
  };
}

function launch(): WorkerLaunch {
  return {
    schema_version: 1,
    invocation: { invocation_id: ID, path: ['research'], argv: ['--no-llm', 'q'], cwd: CWD },
    result_path: join(home, 'result.json'),
  };
}

function writeLease(
  runId: string,
  owner: ProcessIdentity,
  claimedAt = new Date().toISOString(),
): void {
  mkdirSync(join(runs, runId), { recursive: true });
  writeFileSync(
    join(runs, runId, 'lease.json'),
    JSON.stringify({
      schema_version: 1,
      run_id: runId,
      owner: { pid: owner.pid, start_token: owner.startToken },
      origin: 'worker',
      execution_class: 'run',
      command: ['research'],
      socket: { kind: 'unix', address: `/home/u/.yantra/run/${'a'.repeat(24)}.sock` },
      run_token: TOKEN,
      channel_version: 1,
      yantra_version: '0.0.1',
      log_seq_at_claim: 0,
      claimed_at: claimedAt,
    }),
  );
}

beforeEach(() => {
  previousHome = process.env.YANTRA_HOME;
  home = mkdtempSync(join(tmpdir(), 'yantra-worker-claim-'));
  process.env.YANTRA_HOME = home;
  resetPathCache();
  store = new FileInvocationStore();
  runs = join(home, 'data', 'runs');
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.YANTRA_HOME;
  else process.env.YANTRA_HOME = previousHome;
  resetPathCache();
  rmSync(home, { recursive: true, force: true });
});

describe('claimInvocation', () => {
  const deps = () => ({ store, identity: () => Promise.resolve(ME), runsRoot: runs });

  it('leaves a plain FEAT-064 launch (no record) ungated', async () => {
    expect(await claimInvocation(launch(), deps())).toBe('not_app_launch');
  });

  it('claims a reserved invocation and records the worker', async () => {
    await store.create(record());
    await store.reserve(ID, () => null);
    expect(await claimInvocation(launch(), deps())).toBe('claimed');
    expect((await store.get(ID))?.worker).toEqual({ pid: 4242, start_token: 'me' });
  });

  it('is refused after the host withdrew the invocation', async () => {
    await store.create(record());
    await store.reserve(ID, () => null);
    await store.markNeverStarted(ID);
    expect(await claimInvocation(launch(), deps())).toBe('refused');
  });
});

describe('a refused claim', () => {
  it('exits 0 without running anything or creating a run directory', async () => {
    // Arrange: a withdrawn invocation and a real launch file in the launch directory.
    await store.create(record());
    await store.reserve(ID, () => null);
    await store.discard(ID);
    const launchDir = join(home, 'launch');
    mkdirSync(launchDir, { recursive: true });
    const launchPath = join(launchDir, `${ID}.launch.json`);
    writeFileSync(
      launchPath,
      JSON.stringify({ ...launch(), result_path: join(launchDir, `${ID}.result.json`) }),
    );
    const run = vi.fn();
    const lifecycle = invocationLifecycle({
      store,
      identity: () => Promise.resolve(ME),
      runsRoot: runs,
    });

    // Act
    const code = await runWorker(['--launch', launchPath], {
      env: { YANTRA_WORKER_LAUNCH_DIR: launchDir },
      chdir: () => undefined,
      gate: lifecycle.gate,
      run,
    });
    await lifecycle.finish(code);

    // Assert
    expect(code).toBe(0);
    expect(run).not.toHaveBeenCalled();
    expect((await store.get(ID))?.state).toBe('discarded');
    expect(await findOwnedRun(runs, ME, 0)).toBeNull();
  });
});

describe('findOwnedRun', () => {
  it('finds the run whose lease this process owns', async () => {
    writeLease('20261111T100000Z-other-0001', { pid: 1, startToken: 'x' });
    writeLease('20261111T100000Z-mine-0002', ME);
    expect(await findOwnedRun(runs, ME, Date.now() - 5_000)).toBe('20261111T100000Z-mine-0002');
  });

  it('ignores a lease with the same PID but another start token (PID reuse)', async () => {
    writeLease('20261111T100000Z-reused-0003', { pid: ME.pid, startToken: 'older' });
    expect(await findOwnedRun(runs, ME, 0)).toBeNull();
  });

  it('ignores a lease claimed before this worker started', async () => {
    writeLease('20261111T100000Z-old-0004', ME, '2020-01-01T00:00:00.000Z');
    expect(await findOwnedRun(runs, ME, Date.now())).toBeNull();
  });
});

describe('the lifecycle', () => {
  it('marks the invocation running with its run once the lease exists, then finishes it', async () => {
    // Arrange
    await store.create(record());
    await store.reserve(ID, () => null);
    await store.markSpawning(ID);
    const lifecycle = invocationLifecycle({
      store,
      identity: () => Promise.resolve(ME),
      runsRoot: runs,
      pollMs: 20,
    });

    // Act: the gate claims; the command creates its run; it completes.
    expect(await lifecycle.gate(launch())).toBe(true);
    writeLease('20261111T100000Z-research-0005', ME);
    await vi.waitFor(async () => {
      expect((await store.get(ID))?.state).toBe('running');
    });
    await lifecycle.finish(2);

    // Assert
    expect(await store.get(ID)).toMatchObject({
      state: 'finished',
      run_id: '20261111T100000Z-research-0005',
      result: { exit_code: 2 },
    });
  });

  it('finishes a mutate command that never creates a run from claimed', async () => {
    await store.create({ ...record(), execution_class: 'mutate' });
    await store.reserve(ID, () => null);
    const lifecycle = invocationLifecycle({
      store,
      identity: () => Promise.resolve(ME),
      runsRoot: runs,
    });
    await lifecycle.gate(launch());
    await lifecycle.finish(0);
    expect(await store.get(ID)).toMatchObject({ state: 'finished', run_id: null });
  });
});
