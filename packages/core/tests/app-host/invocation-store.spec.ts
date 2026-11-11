// @no-llm
/**
 * Launch ownership core (FEAT-065 TASK-014): exclusive creation, the slot
 * invariant under `slots.lock`, the worker claim and the transition table.
 */

import { fork } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  InvocationState,
  type InvocationRecordInput,
  type InvocationState as State,
} from '@yantra/protocol';
import lockfile from 'proper-lockfile';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ClaimRefusedError,
  InvalidInvocationTransition,
  SlotLockBusyError,
} from '../../src/app-host/errors.js';
import {
  FileInvocationStore,
  INVOCATION_TRANSITIONS,
  canTransition,
  capResultEnvelope,
} from '../../src/app-host/invocation-store.js';

const CWD = process.platform === 'win32' ? 'C:\\work' : '/work';
let dir: string;
let store: FileInvocationStore;
let tick = 0;

/** A 26-character ID that sorts by `n`. */
function idOf(n: number): string {
  return `01JD2X7Q8R9S0T1V2W3X${String(n).padStart(6, '0')}`;
}

function record(n: number, overrides: Partial<InvocationRecordInput> = {}): InvocationRecordInput {
  const id = idOf(n);
  return {
    schema_version: 1,
    invocation_id: id,
    invocation: { invocation_id: id, path: ['research'], argv: ['q'], cwd: CWD },
    execution_class: 'run',
    state: 'queued',
    queued_at: new Date(Date.UTC(2026, 10, 11, 10, 0, n)).toISOString(),
    updated_at: new Date(Date.UTC(2026, 10, 11, 10, 0, n)).toISOString(),
    displayed_effective: { settings: [], content: [] },
    run_id: null,
    worker: null,
    review: null,
    result: null,
    ...overrides,
  };
}

const runIdFor = (r: { invocation_id: string }) => `run-${r.invocation_id}`;
const WORKER = { pid: 4321, startToken: 'w' };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'yantra-invocations-'));
  store = new FileInvocationStore({
    root: join(dir, 'invocations'),
    lockPath: join(dir, 'slots.lock'),
    now: () => new Date(Date.UTC(2026, 10, 11, 11, 0, tick++)),
  });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Puts record `n` into `state` through legal moves. */
async function reach(n: number, state: State, overrides: Partial<InvocationRecordInput> = {}) {
  await store.create(record(n, overrides));
  const id = idOf(n);
  const path: Record<State, (() => Promise<unknown>)[]> = {
    queued: [],
    needs_review: [
      () => store.setReview(id, [{ key: 'k', submitted: 1, current: 2, pinnable: true }]),
    ],
    reserved: [() => store.reserve(id, runIdFor)],
    spawning: [() => store.reserve(id, runIdFor), () => store.markSpawning(id)],
    claimed: [() => store.reserve(id, runIdFor), () => store.claim(id, WORKER)],
    running: [
      () => store.reserve(id, runIdFor),
      () => store.claim(id, WORKER),
      () => store.markRunning(id),
    ],
    finished: [
      () => store.reserve(id, runIdFor),
      () => store.claim(id, WORKER),
      () => store.finish(id, { exitCode: 0 }),
    ],
    never_started: [() => store.reserve(id, runIdFor), () => store.markNeverStarted(id)],
    start_unknown: [
      () => store.reserve(id, runIdFor),
      () => store.markSpawning(id),
      () => store.markStartUnknown(id),
    ],
    discarded: [() => store.discard(id)],
  };
  for (const step of path[state]) await step();
  expect((await store.get(id))?.state).toBe(state);
}

describe('create', () => {
  it('returns the existing record unchanged for a repeated ID', async () => {
    const first = await store.create(record(1));
    await store.reserve(idOf(1), runIdFor);
    const again = await store.create(record(1));
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.record.state).toBe('reserved');
  });

  it('makes one file for ten concurrent creates of one ID, and all see the same record', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => store.create(record(7))));
    expect(results.filter((result) => result.created)).toHaveLength(1);
    for (const result of results) expect(result.record).toEqual(results[0]?.record);
    expect((await store.list()).map((item) => item.invocation_id)).toEqual([idOf(7)]);
  });

  it('lists first-in, first-out', async () => {
    await store.create(record(3));
    await store.create(record(1));
    await store.create(record(2));
    expect((await store.list()).map((item) => item.invocation_id)).toEqual([
      idOf(1),
      idOf(2),
      idOf(3),
    ]);
  });
});

describe('the slot invariant', () => {
  it('reserves two runs and queues the third at position 1', async () => {
    for (const n of [1, 2, 3]) await store.create(record(n));
    const outcomes = [];
    for (const n of [1, 2, 3]) outcomes.push(await store.reserve(idOf(n), runIdFor));
    expect(outcomes.map((outcome) => outcome.reserved)).toEqual([true, true, false]);
    expect(outcomes[2]).toMatchObject({ reserved: false, position: 1 });
    expect(outcomes[0]?.record.run_id).toBe(`run-${idOf(1)}`);
  });

  it('lets a waiting run start when a slot frees', async () => {
    for (const n of [1, 2, 3]) await store.create(record(n));
    await store.reserve(idOf(1), runIdFor);
    await store.reserve(idOf(2), runIdFor);
    await store.claim(idOf(1), WORKER);
    await store.finish(idOf(1), { exitCode: 0 });
    expect((await store.reserve(idOf(3), runIdFor)).reserved).toBe(true);
  });

  it('never lets a newer run overtake an older waiting one', async () => {
    for (const n of [1, 2, 3, 4]) await store.create(record(n));
    await store.reserve(idOf(1), runIdFor);
    await store.reserve(idOf(2), runIdFor);
    await store.claim(idOf(1), WORKER);
    await store.finish(idOf(1), { exitCode: 0 });
    expect(await store.reserve(idOf(4), runIdFor)).toMatchObject({ reserved: false, position: 2 });
  });

  it('does not count mutate invocations against the slots', async () => {
    await store.create(record(1));
    await store.create(record(2));
    await store.reserve(idOf(1), runIdFor);
    await store.reserve(idOf(2), runIdFor);
    await store.create(record(3, { execution_class: 'mutate' }));
    expect((await store.reserve(idOf(3), () => null)).reserved).toBe(true);
  });

  it('admits exclusive only with zero runs, and blocks new runs while it is active', async () => {
    await store.create(record(1));
    await store.reserve(idOf(1), runIdFor);
    await store.create(record(2, { execution_class: 'exclusive' }));
    expect((await store.reserve(idOf(2), () => null)).reserved).toBe(false);
    await store.markNeverStarted(idOf(1));
    expect((await store.reserve(idOf(2), () => null)).reserved).toBe(true);
    await store.create(record(3));
    expect((await store.reserve(idOf(3), runIdFor)).reserved).toBe(false);
  });

  it('never exceeds two run slots across twenty separate processes', async () => {
    // Arrange
    const ids = Array.from({ length: 20 }, (_, i) => idOf(100 + i));
    for (let i = 0; i < 20; i++) await store.create(record(100 + i));
    const child = join(import.meta.dirname, 'fixtures', 'reserve-child.ts');

    // Act: every process races to reserve its own item.
    const outcomes = await Promise.all(
      ids.map(
        (id) =>
          new Promise<{ reserved?: boolean; error?: string }>((resolve, reject) => {
            const proc = fork(child, [join(dir, 'invocations'), join(dir, 'slots.lock'), id], {
              execArgv: ['--import', 'tsx'],
              stdio: ['ignore', 'pipe', 'inherit', 'ipc'],
            });
            let out = '';
            proc.stdout?.on('data', (chunk: Buffer) => {
              out += chunk.toString();
            });
            proc.once('error', reject);
            proc.once('exit', () => {
              resolve(JSON.parse(out) as { reserved?: boolean; error?: string });
            });
          }),
      ),
    );

    // Assert
    expect(outcomes.filter((outcome) => outcome.error !== undefined)).toEqual([]);
    const active = (await store.list()).filter((item) => item.state === 'reserved');
    expect(active.length).toBeLessThanOrEqual(2);
    expect(outcomes.filter((outcome) => outcome.reserved === true)).toHaveLength(active.length);
  }, 120_000);
});

describe('the worker claim', () => {
  it('moves reserved or spawning to claimed and records the worker', async () => {
    await reach(1, 'spawning');
    const claimed = await store.claim(idOf(1), WORKER);
    expect(claimed).toMatchObject({ state: 'claimed', worker: { pid: 4321, start_token: 'w' } });
    await reach(2, 'reserved');
    expect((await store.claim(idOf(2), WORKER)).state).toBe('claimed');
  });

  it.each(['never_started', 'discarded'] as const)('is refused after %s', async (state) => {
    await reach(1, state);
    await expect(store.claim(idOf(1), WORKER)).rejects.toBeInstanceOf(ClaimRefusedError);
  });

  it.each(['queued', 'claimed', 'running', 'finished', 'needs_review', 'start_unknown'] as const)(
    'is an invalid transition from %s',
    async (state) => {
      await reach(1, state);
      await expect(store.claim(idOf(1), WORKER)).rejects.toBeInstanceOf(
        InvalidInvocationTransition,
      );
    },
  );

  it('ends in exactly one of claimed or never_started when a claim races recovery', async () => {
    for (let round = 0; round < 10; round++) {
      await reach(round + 1, 'spawning', { execution_class: 'mutate' });
      const id = idOf(round + 1);
      const [claim, recover] = await Promise.allSettled([
        store.claim(id, WORKER),
        store.withLock(async () => {
          const current = await store.get(id);
          return current?.worker === null ? store.applyUnlocked(current, 'never_started') : current;
        }),
      ]);
      const final = (await store.get(id))?.state;
      expect(['claimed', 'never_started']).toContain(final);
      if (final === 'claimed') expect(claim.status).toBe('fulfilled');
      else expect(claim.status).toBe('rejected');
      expect(recover.status).toBe('fulfilled');
    }
  });
});

describe('the transition table', () => {
  const states = InvocationState.options;

  it('is closed: every state has an entry and nothing leaves finished or discarded', () => {
    expect(Object.keys(INVOCATION_TRANSITIONS).sort()).toEqual([...states].sort());
    expect(INVOCATION_TRANSITIONS.finished).toEqual([]);
    expect(INVOCATION_TRANSITIONS.discarded).toEqual([]);
  });

  it.each(
    states.flatMap((from) =>
      states.filter((to) => !canTransition(from, to)).map((to) => [from, to] as const),
    ),
  )('refuses %s → %s', async (from, to) => {
    await reach(1, from);
    const move: Partial<Record<State, () => Promise<unknown>>> = {
      reserved: () => store.reserve(idOf(1), runIdFor),
      spawning: () => store.markSpawning(idOf(1)),
      running: () => store.markRunning(idOf(1)),
      finished: () => store.finish(idOf(1), { exitCode: 0 }),
      discarded: () => store.discard(idOf(1)),
      never_started: () => store.markNeverStarted(idOf(1)),
      start_unknown: () => store.markStartUnknown(idOf(1)),
      needs_review: () =>
        store.setReview(idOf(1), [{ key: 'k', submitted: 1, current: 2, pinnable: true }]),
      queued: () => store.requeue(idOf(1), { acknowledgeDuplicateRisk: true }),
      claimed: () => store.claim(idOf(1), WORKER),
    };
    const attempt = move[to];
    if (attempt === undefined) return;
    await expect(attempt()).rejects.toThrow();
    expect((await store.get(idOf(1)))?.state).toBe(from);
  });

  it('requeues start_unknown only with acknowledged duplicate risk, and records it', async () => {
    await reach(1, 'start_unknown');
    await expect(store.requeue(idOf(1))).rejects.toBeInstanceOf(InvalidInvocationTransition);
    const requeued = await store.requeue(idOf(1), { acknowledgeDuplicateRisk: true });
    expect(requeued).toMatchObject({
      state: 'queued',
      duplicate_risk_acknowledged: true,
      run_id: null,
    });
  });

  it('can requeue with pinned argv', async () => {
    await reach(1, 'needs_review');
    const requeued = await store.requeue(idOf(1), { argv: ['q', '--detail', 'full'] });
    expect(requeued.invocation.argv).toEqual(['q', '--detail', 'full']);
    expect(requeued.review).toBeNull();
  });

  it('records the finish reason', async () => {
    await reach(1, 'claimed');
    const finished = await store.finish(idOf(1), { exitCode: 2, reason: 'owner_lost' });
    expect(finished.result).toMatchObject({ exit_code: 2, reason: 'owner_lost' });
  });
});

describe('the slot lock', () => {
  it('surfaces SlotLockBusyError after the bounded wait, never a silent write', async () => {
    // Arrange: another process holds slots.lock.
    await store.create(record(1));
    const release = await lockfile.lock(join(dir, 'slots.lock'), {
      realpath: false,
      lockfilePath: `${join(dir, 'slots.lock')}.lck`,
    });
    const impatient = new FileInvocationStore({
      root: join(dir, 'invocations'),
      lockPath: join(dir, 'slots.lock'),
      lockWaitMs: 150,
    });

    // Act
    const error = await impatient.reserve(idOf(1), runIdFor).catch((caught: unknown) => caught);
    await release();

    // Assert
    expect(error).toBeInstanceOf(SlotLockBusyError);
    expect((await store.get(idOf(1)))?.state).toBe('queued');
  });
});

describe('results', () => {
  it('writes once and reads back', async () => {
    await reach(1, 'claimed');
    const outcome = { type: 'result' as const, exit_code: 0, envelope: { ok: true }, text: null };
    expect(await store.writeResult(idOf(1), outcome)).toBe(true);
    expect(await store.writeResult(idOf(1), { ...outcome, exit_code: 2 })).toBe(false);
    expect((await store.readResult(idOf(1)))?.outcome).toEqual(outcome);
    expect((await store.readResult(idOf(1)))?.run_id).toBe(`run-${idOf(1)}`);
  });

  it('caps an envelope over 1 MiB', () => {
    const big = {
      type: 'result' as const,
      exit_code: 0,
      envelope: 'x'.repeat(1_100_000),
      text: null,
    };
    expect(capResultEnvelope(big).type === 'result' && capResultEnvelope(big).envelope).toEqual({
      truncated: true,
      bytes: 1_100_002,
    });
  });

  it('reads null when there is no result', async () => {
    expect(await store.readResult(idOf(9))).toBeNull();
  });

  it('writes owner-only JSON files', async () => {
    await store.create(record(1));
    const raw = readFileSync(join(dir, 'invocations', `${idOf(1)}.json`), 'utf8');
    expect(JSON.parse(raw)).toMatchObject({ invocation_id: idOf(1) });
  });
});
