// @no-llm
/**
 * Host-start recovery (FEAT-065 TASK-016): dead owners are reconciled exactly
 * once, live ones are left to attach, and a second host is refused.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  FileHostLock,
  FileInvocationStore,
  resetPathCache,
  type LivenessVerdict,
  type ProcessIdentity,
  type ProcessLivenessProbe,
} from '@yantra/core';
import type { InvocationRecordInput } from '@yantra/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HostStartError } from '../../../src/ui/host/errors.js';
import { startHostRuntime, type RunningHost } from '../../../src/ui/host/host-runtime.js';
import type { HostLogger } from '../../../src/ui/host/host.js';
import { OWNER_LOST_EXIT_CODE, recoverHost } from '../../../src/ui/host/recovery.js';

import { cleanupTempDirs, makeWebBuild } from './support.js';

class TableProbe implements ProcessLivenessProbe {
  public readonly table = new Map<string, LivenessVerdict>();
  public identify(pid: number): Promise<ProcessIdentity | null> {
    return Promise.resolve({ pid, startToken: 't' });
  }
  public check(identity: ProcessIdentity): Promise<LivenessVerdict> {
    return Promise.resolve(this.table.get(`${identity.pid}:${identity.startToken}`) ?? 'dead');
  }
}

const CWD = process.platform === 'win32' ? 'C:\\work' : '/work';
let home: string;
let previousHome: string | undefined;
let store: FileInvocationStore;
let probe: TableProbe;
let logs: string[];

const logger: HostLogger = {
  info: (_fields, message) => logs.push(message),
  warn: (_fields, message) => logs.push(message),
  error: (_fields, message) => logs.push(message),
};

function idOf(n: number): string {
  return `01JD2X7Q8R9S0T1V2W3X${String(n).padStart(6, '0')}`;
}

function record(n: number): InvocationRecordInput {
  const id = idOf(n);
  return {
    schema_version: 1,
    invocation_id: id,
    invocation: { invocation_id: id, path: ['research'], argv: ['q'], cwd: CWD },
    execution_class: 'mutate',
    state: 'queued',
    queued_at: new Date(Date.UTC(2026, 10, 11, 10, 0, n)).toISOString(),
    updated_at: new Date(Date.UTC(2026, 10, 11, 10, 0, n)).toISOString(),
    displayed_effective: { settings: [], content: [] },
    run_id: null,
    worker: null,
    review: null,
    result: null,
  };
}

async function running(n: number, worker: ProcessIdentity, runId: string): Promise<void> {
  await store.create(record(n));
  await store.reserve(idOf(n), () => null);
  await store.claim(idOf(n), worker);
  await store.markRunning(idOf(n), runId);
}

beforeEach(() => {
  previousHome = process.env.YANTRA_HOME;
  home = mkdtempSync(join(tmpdir(), 'yantra-host-recovery-'));
  process.env.YANTRA_HOME = home;
  resetPathCache();
  store = new FileInvocationStore();
  probe = new TableProbe();
  logs = [];
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.YANTRA_HOME;
  else process.env.YANTRA_HOME = previousHome;
  resetPathCache();
  rmSync(home, { recursive: true, force: true });
  cleanupTempDirs();
});

describe('recoverHost', () => {
  it('reconciles a dead running worker’s run once, then finishes it as owner_lost', async () => {
    // Arrange
    await running(1, { pid: 10, startToken: 'gone' }, 'run-dead');
    const reconcile = vi.fn(() => Promise.resolve({ kind: 'no_lease' as const }));

    // Act
    const report = await recoverHost({
      store,
      probe,
      runsRoot: join(home, 'runs'),
      logger,
      reconcile,
    });

    // Assert
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledWith(
      join(home, 'runs', 'run-dead'),
      expect.objectContaining({ trigger: 'host' }),
    );
    expect(report.reconciled).toEqual([idOf(1)]);
    expect(await store.get(idOf(1))).toMatchObject({
      state: 'finished',
      result: { exit_code: OWNER_LOST_EXIT_CODE, reason: 'owner_lost' },
    });
  });

  it('leaves a live worker running for the relay to attach', async () => {
    probe.table.set('11:alive', 'alive');
    await running(1, { pid: 11, startToken: 'alive' }, 'run-live');
    const reconcile = vi.fn();
    const report = await recoverHost({
      store,
      probe,
      runsRoot: join(home, 'runs'),
      logger,
      reconcile,
    });
    expect(report.verdicts).toEqual(['attach']);
    expect(reconcile).not.toHaveBeenCalled();
    expect((await store.get(idOf(1)))?.state).toBe('running');
  });

  it('never spawns anything itself', async () => {
    await store.create(record(1));
    await recoverHost({ store, probe, runsRoot: join(home, 'runs'), logger });
    expect((await store.get(idOf(1)))?.state).toBe('queued');
  });

  it('is idempotent: a second recovery reconciles nothing more', async () => {
    await running(1, { pid: 12, startToken: 'gone' }, 'run-dead');
    const reconcile = vi.fn(() => Promise.resolve({ kind: 'no_lease' as const }));
    await recoverHost({ store, probe, runsRoot: join(home, 'runs'), logger, reconcile });
    await recoverHost({ store, probe, runsRoot: join(home, 'runs'), logger, reconcile });
    expect(reconcile).toHaveBeenCalledTimes(1);
  });
});

describe('two hosts starting at once', () => {
  it('reconciles a dead claimed record exactly once: the second host is refused by the host lock', async () => {
    // Arrange: a dead worker's record, and two hosts that both read as alive.
    await running(1, { pid: 13, startToken: 'gone' }, 'run-dead');
    probe.table.set('900001:h', 'alive');
    probe.table.set('900002:h', 'alive');
    const start = (pid: number) =>
      startHostRuntime({
        assetsRoot: makeWebBuild(),
        identity: { pid, startToken: 'h' },
        yantraVersion: '1',
        lock: new FileHostLock({ liveness: probe }),
        probe,
        logger,
        supervisor: { spawn: () => Promise.reject(new Error('no spawning in this test')) },
      });

    // Act
    const outcomes = await Promise.allSettled([start(900_001), start(900_002)]);

    // Assert
    const started = outcomes.filter(
      (o): o is PromiseFulfilledResult<RunningHost> => o.status === 'fulfilled',
    );
    const refused = outcomes.filter((o) => o.status === 'rejected');
    expect(started).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect((refused[0] as PromiseRejectedResult).reason).toBeInstanceOf(HostStartError);
    expect(logs.filter((line) => line === 'reconciliation')).toHaveLength(1);
    expect((await store.get(idOf(1)))?.result).toMatchObject({ reason: 'owner_lost' });
    for (const host of started) await host.value.stop();
  });
});
