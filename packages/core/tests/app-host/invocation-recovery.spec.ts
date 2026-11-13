// @no-llm
/**
 * Host-start recovery of invocations (FEAT-065 TASK-014): the verdict table.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { InvocationRecordInput } from '@yantra/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { recoverInvocations } from '../../src/app-host/invocation-recovery.js';
import { FileInvocationStore } from '../../src/app-host/invocation-store.js';
import type {
  LivenessVerdict,
  ProcessIdentity,
  ProcessLivenessProbe,
} from '../../src/browser/installation-types.js';

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
let dir: string;
let store: FileInvocationStore;
let probe: TableProbe;

function idOf(n: number): string {
  return `01JD2X7Q8R9S0T1V2W3X${String(n).padStart(6, '0')}`;
}

function record(n: number, execution_class: 'run' | 'mutate' = 'mutate'): InvocationRecordInput {
  const id = idOf(n);
  return {
    schema_version: 1,
    invocation_id: id,
    invocation: { invocation_id: id, path: ['research'], argv: [], cwd: CWD },
    execution_class,
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

async function claimed(n: number, worker: ProcessIdentity, running = false): Promise<void> {
  await store.create(record(n));
  await store.reserve(idOf(n), () => null);
  await store.claim(idOf(n), worker);
  if (running) await store.markRunning(idOf(n));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'yantra-recovery-'));
  store = new FileInvocationStore({
    root: join(dir, 'invocations'),
    lockPath: join(dir, 'slots.lock'),
  });
  probe = new TableProbe();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('recoverInvocations', () => {
  it('marks unclaimed reserved and spawning items never_started', async () => {
    await store.create(record(1));
    await store.reserve(idOf(1), () => null);
    await store.create(record(2));
    await store.reserve(idOf(2), () => null);
    await store.markSpawning(idOf(2));

    const verdicts = await recoverInvocations({ store, probe });

    expect(verdicts.map((verdict) => [verdict.kind, verdict.record.state])).toEqual([
      ['never_started', 'never_started'],
      ['never_started', 'never_started'],
    ]);
    expect((await store.get(idOf(1)))?.state).toBe('never_started');
  });

  it('returns attach for a claimed item whose worker is alive', async () => {
    const worker = { pid: 11, startToken: 'a' };
    probe.table.set('11:a', 'alive');
    await claimed(1, worker);
    expect((await recoverInvocations({ store, probe })).map((v) => v.kind)).toEqual(['attach']);
    expect((await store.get(idOf(1)))?.state).toBe('claimed');
  });

  it('returns reconcile for a running item whose worker is dead', async () => {
    await claimed(1, { pid: 12, startToken: 'b' }, true);
    expect((await recoverInvocations({ store, probe })).map((v) => v.kind)).toEqual(['reconcile']);
  });

  it('treats a reused PID (a different start token) as dead', async () => {
    probe.table.set('13:someone-else', 'alive');
    await claimed(1, { pid: 13, startToken: 'mine' });
    expect((await recoverInvocations({ store, probe })).map((v) => v.kind)).toEqual(['reconcile']);
  });

  it('never changes an item whose owner is unknown', async () => {
    probe.table.set('14:c', 'unknown');
    await claimed(1, { pid: 14, startToken: 'c' });
    const verdicts = await recoverInvocations({ store, probe });
    expect(verdicts.map((v) => v.kind)).toEqual(['unverifiable']);
    expect((await store.get(idOf(1)))?.state).toBe('claimed');
  });

  it('leaves queued, finished and discarded items alone', async () => {
    await store.create(record(1));
    await store.create(record(2));
    await store.discard(idOf(2));
    expect(await recoverInvocations({ store, probe })).toEqual([]);
  });

  it('makes a late worker’s claim fail after recovery', async () => {
    await store.create(record(1));
    await store.reserve(idOf(1), () => null);
    await store.markSpawning(idOf(1));
    await recoverInvocations({ store, probe });
    await expect(store.claim(idOf(1), { pid: 1, startToken: 'late' })).rejects.toThrow(
      /does not own/u,
    );
  });
});
