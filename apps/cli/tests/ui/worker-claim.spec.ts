// @no-llm
/**
 * The worker's app-launch path (FEAT-065 TASK-015): claim first, record the
 * run this process claims (announced in-process, REV-011), record the exit;
 * a refused claim does nothing at all.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileInvocationStore, resetPathCache, type ProcessIdentity } from '@yantra/core';
import type { InvocationRecordInput, RunLease, WorkerLaunch } from '@yantra/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { claimInvocation, invocationLifecycle, ownedBy } from '../../src/ui/worker-claim.js';
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

function leaseOf(
  runId: string,
  owner: ProcessIdentity,
  claimedAt = new Date().toISOString(),
): RunLease {
  return {
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
  } as RunLease;
}

/** Stands in for core's in-process claim notice. */
class Claims {
  private readonly listeners = new Set<(lease: RunLease) => void>();
  public readonly subscribe = (listener: (lease: RunLease) => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  public announce(lease: RunLease): void {
    for (const listener of [...this.listeners]) listener(lease);
  }
  public get count(): number {
    return this.listeners.size;
  }
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
  const deps = () => ({ store, identity: () => Promise.resolve(ME) });

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
    expect(existsSync(runs)).toBe(false);
  });
});

describe('ownedBy', () => {
  it('matches a lease this process claimed after it started', () => {
    expect(ownedBy(leaseOf('20261111T100000Z-mine-0002', ME), ME, Date.now() - 5_000)).toBe(true);
  });

  it('rejects another process', () => {
    expect(ownedBy(leaseOf('r', { pid: 1, startToken: 'x' }), ME, 0)).toBe(false);
  });

  it('rejects the same PID with another start token (PID reuse)', () => {
    expect(ownedBy(leaseOf('r', { pid: ME.pid, startToken: 'older' }), ME, 0)).toBe(false);
  });

  it('rejects a lease claimed before this worker started', () => {
    expect(ownedBy(leaseOf('r', ME, '2020-01-01T00:00:00.000Z'), ME, Date.now())).toBe(false);
  });
});

describe('the lifecycle', () => {
  async function claimedLifecycle(executionClass: 'run' | 'mutate' = 'run') {
    await store.create({ ...record(), execution_class: executionClass });
    await store.reserve(ID, () => null);
    if (executionClass === 'run') await store.markSpawning(ID);
    const claims = new Claims();
    const lifecycle = invocationLifecycle({
      store,
      identity: () => Promise.resolve(ME),
      onLeaseClaimed: claims.subscribe,
    });
    expect(await lifecycle.gate(launch())).toBe(true);
    return { claims, lifecycle };
  }

  it('marks the invocation running with the run it claims, then finishes it', async () => {
    const { claims, lifecycle } = await claimedLifecycle();

    claims.announce(leaseOf('20261111T100000Z-research-0005', ME));
    await vi.waitFor(async () => {
      expect((await store.get(ID))?.state).toBe('running');
    });
    await lifecycle.finish(2);

    expect(await store.get(ID)).toMatchObject({
      state: 'finished',
      run_id: '20261111T100000Z-research-0005',
      result: { exit_code: 2 },
    });
  });

  it("ignores another process's lease and records only the first run this one claims", async () => {
    const { claims, lifecycle } = await claimedLifecycle();

    claims.announce(leaseOf('20261111T100000Z-other-0001', { pid: 1, startToken: 'x' }));
    claims.announce(leaseOf('20261111T100000Z-mine-0002', ME));
    claims.announce(leaseOf('20261111T100000Z-nested-0003', ME));
    await lifecycle.finish(0);

    expect(await store.get(ID)).toMatchObject({
      state: 'finished',
      run_id: '20261111T100000Z-mine-0002',
    });
    expect(claims.count).toBe(0);
  });

  it('records the run of a command that finishes immediately after claiming it', async () => {
    const { claims, lifecycle } = await claimedLifecycle();

    claims.announce(leaseOf('20261111T100000Z-fast-0006', ME));
    await lifecycle.finish(0);

    expect(await store.get(ID)).toMatchObject({
      state: 'finished',
      run_id: '20261111T100000Z-fast-0006',
    });
  });

  it('finishes a mutate command that never creates a run from claimed, and stops listening', async () => {
    const { claims, lifecycle } = await claimedLifecycle('mutate');
    expect(claims.count).toBe(1);

    await lifecycle.finish(0);

    expect(await store.get(ID)).toMatchObject({ state: 'finished', run_id: null });
    expect(claims.count).toBe(0);
  });

  it('never listens for a plain launch with no invocation record', async () => {
    const claims = new Claims();
    const lifecycle = invocationLifecycle({
      store,
      identity: () => Promise.resolve(ME),
      onLeaseClaimed: claims.subscribe,
    });
    expect(await lifecycle.gate(launch())).toBe(true);
    expect(claims.count).toBe(0);
    await lifecycle.finish(0);
  });
});
