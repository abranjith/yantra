import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runMigrations } from '../../src/index-db/migrations.js';
import {
  SqliteScheduleStore,
  type Schedule,
  type ScheduleStore,
} from '../../src/index-db/schedule-store.js';
import { DatabaseSync } from '../../src/index-db/sqlite.js';
import type { DaemonLock } from '../../src/scheduler/daemon-lock.js';
import { SchedulerDaemon, type FireFn, type FireResult } from '../../src/scheduler/daemon.js';

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

function makeStore(clock?: { now(): Date }): { store: SqliteScheduleStore; db: DatabaseSync } {
  const db = new DatabaseSync(':memory:');
  runMigrations(db);
  return {
    store: new SqliteScheduleStore({ db, ...(clock ? { clock } : {}) }),
    db,
  };
}

/** A fake in-memory lock: single-holder, reports pid via probe(). */
function makeFakeLock(): DaemonLock & { held: boolean } {
  const state = { held: false, pid: null as number | null };
  return {
    get held() {
      return state.held;
    },
    set held(v: boolean) {
      state.held = v;
    },
    acquire(pid: number): Promise<() => Promise<void>> {
      if (state.held) {
        return Promise.reject(new Error('lock held'));
      }
      state.held = true;
      state.pid = pid;
      return Promise.resolve(() =>
        Promise.resolve().then(() => {
          state.held = false;
          state.pid = null;
        }),
      );
    },
    probe() {
      return Promise.resolve(state.held ? { pid: state.pid } : null);
    },
  };
}

/** Manual timer harness: capture the interval callback, fire it on demand. */
function makeManualTimers(): {
  timers: {
    setInterval(fn: () => void, ms: number): { unref?(): void };
    clearInterval(h: unknown): void;
  };
  fireInterval(): void;
  cleared: () => boolean;
} {
  let cb: (() => void) | null = null;
  let cleared = false;
  return {
    timers: {
      setInterval: (fn) => {
        cb = fn;
        return { unref: () => undefined };
      },
      clearInterval: () => {
        cleared = true;
      },
    },
    fireInterval: () => {
      if (cb !== null) cb();
    },
    cleared: () => cleared,
  };
}

/** A mutable clock shared between the store (for `created_at`) and the daemon. */
interface MutableClock {
  value: Date;
  now(): Date;
}

function mutableClock(initial: Date): MutableClock {
  const clock: MutableClock = {
    value: initial,
    now() {
      return this.value;
    },
  };
  return clock;
}

describe('@no-llm SchedulerDaemon', () => {
  let db: DatabaseSync;
  let store: ScheduleStore;
  let clock: MutableClock;

  beforeEach(() => {
    clock = mutableClock(new Date('2026-07-05T00:00:00.000Z'));
    const made = makeStore(clock);
    db = made.db;
    store = made.store;
  });

  afterEach(() => {
    db.close();
  });

  it('refuses to start a second instance while the lock is held', async () => {
    const lock = makeFakeLock();
    const fire: FireFn = () => Promise.resolve({ runId: 'r', status: 'succeeded' });
    const timers = makeManualTimers().timers;

    const d1 = new SchedulerDaemon({ store, lock, fire, logger: silentLogger, timers });
    await d1.start(111);

    const d2 = new SchedulerDaemon({ store, lock, fire, logger: silentLogger, timers });
    await expect(d2.start(222)).rejects.toThrow();

    await d1.stop();
    // Now the lock is free — a fresh daemon can start.
    const d3 = new SchedulerDaemon({ store, lock, fire, logger: silentLogger, timers });
    await expect(d3.start(333)).resolves.toBeUndefined();
    await d3.stop();
  });

  it('picks up a schedule registered after the daemon started, within a poll cycle', async () => {
    const lock = makeFakeLock();
    const fired: string[] = [];
    const fire: FireFn = (s): Promise<FireResult> => {
      fired.push(s.workflowName);
      return Promise.resolve({ runId: 'r', status: 'succeeded' });
    };
    const harness = makeManualTimers();
    clock.value = new Date('2026-07-05T00:00:30.000Z');
    const daemon = new SchedulerDaemon({
      store,
      lock,
      fire,
      logger: silentLogger,
      timers: harness.timers,
      clock,
    });
    await daemon.start(1);

    // Register a "*/5" schedule created at 00:00:30 → first fire at 00:05:00.
    await store.register({ workflowName: 'demo', cronExpr: '*/5 * * * *' });

    // Tick before the fire time → no fire.
    clock.value = new Date('2026-07-05T00:04:00.000Z');
    harness.fireInterval();
    await flush();
    expect(fired).toEqual([]);

    // Advance past the fire time → picked up on the next poll.
    clock.value = new Date('2026-07-05T00:05:30.000Z');
    harness.fireInterval();
    await flush();
    expect(fired).toEqual(['demo']);

    await daemon.stop();
  });

  it('skips an overlapping fire while the prior one is still running', async () => {
    const lock = makeFakeLock();
    let resolveFire: (() => void) | null = null;
    let fireCount = 0;
    const fire: FireFn = (): Promise<FireResult> => {
      fireCount++;
      return new Promise<FireResult>((resolve) => {
        resolveFire = () => resolve({ runId: 'r', status: 'succeeded' });
      });
    };
    const harness = makeManualTimers();
    clock.value = new Date('2026-07-05T00:00:30.000Z');
    const daemon = new SchedulerDaemon({
      store,
      lock,
      fire,
      logger: silentLogger,
      timers: harness.timers,
      clock,
    });

    // Registered at 00:00:30 → first fire 00:05:00.
    await store.register({ workflowName: 'demo', cronExpr: '*/5 * * * *' });
    await daemon.start(1);

    // Advance past the first fire → a real dispatch begins and stays in flight.
    clock.value = new Date('2026-07-05T00:05:30.000Z');
    harness.fireInterval();
    await flush();
    expect(fireCount).toBe(1); // one fire in flight, unresolved

    // A second tick while the first is still running must NOT start another.
    clock.value = new Date('2026-07-05T00:10:30.000Z');
    harness.fireInterval();
    await flush();
    expect(fireCount).toBe(1); // overlap guard held

    resolveFire?.();
    await flush();
    await daemon.stop();
  });

  it('records fires that were due while the daemon was down as missed', async () => {
    const lock = makeFakeLock();
    const fire: FireFn = () => Promise.resolve({ runId: 'r', status: 'succeeded' });
    const harness = makeManualTimers();
    // Register at 00:00:00 (the beforeEach clock), then start an hour later so a
    // fire was due while the daemon was "down".
    clock.value = new Date('2026-07-05T00:00:00.000Z');
    const reg = await store.register({ workflowName: 'demo', cronExpr: '*/5 * * * *' });
    if (!reg.isOk) throw new Error('register failed');

    clock.value = new Date('2026-07-05T01:00:00.000Z');
    const daemon = new SchedulerDaemon({
      store,
      lock,
      fire,
      logger: silentLogger,
      timers: harness.timers,
      clock,
    });
    await daemon.start(1);
    await flush();

    const got = await store.get(reg.value.id);
    if (!got.isOk || got.value === null) throw new Error('get failed');
    expect(got.value.lastStatus).toBe('missed');

    await daemon.stop();
  });

  it('stops cleanly, clearing the interval and releasing the lock', async () => {
    const lock = makeFakeLock();
    const fire: FireFn = () => Promise.resolve({ runId: 'r', status: 'succeeded' });
    const harness = makeManualTimers();
    const daemon = new SchedulerDaemon({
      store,
      lock,
      fire,
      logger: silentLogger,
      timers: harness.timers,
    });
    await daemon.start(1);
    expect(lock.held).toBe(true);

    await daemon.stop();
    expect(harness.cleared()).toBe(true);
    expect(lock.held).toBe(false);
  });

  it('graceful shutdown waits for an in-flight fire to settle', async () => {
    const lock = makeFakeLock();
    let settled = false;
    let resolveFire: (() => void) | null = null;
    const fire: FireFn = (): Promise<FireResult> =>
      new Promise<FireResult>((resolve) => {
        resolveFire = () => {
          settled = true;
          resolve({ runId: 'r', status: 'succeeded' });
        };
      });
    const harness = makeManualTimers();
    clock.value = new Date('2026-07-05T00:00:30.000Z');
    const daemon = new SchedulerDaemon({
      store,
      lock,
      fire,
      logger: silentLogger,
      timers: harness.timers,
      clock,
    });
    await store.register({ workflowName: 'demo', cronExpr: '*/5 * * * *' });
    await daemon.start(1);
    clock.value = new Date('2026-07-05T00:05:30.000Z');
    harness.fireInterval();
    await flush();

    // stop() must not resolve until the in-flight fire settles.
    const stopPromise = daemon.stop();
    let stopped = false;
    void stopPromise.then(() => {
      stopped = true;
    });
    await flush();
    expect(stopped).toBe(false); // still waiting on the in-flight fire
    expect(settled).toBe(false);

    resolveFire?.();
    await stopPromise;
    expect(settled).toBe(true);
    expect(lock.held).toBe(false);
  });

  it('resumes a parked schedule when its confirmation was granted out-of-band', async () => {
    const lock = makeFakeLock();
    const fire: FireFn = () => Promise.resolve({ runId: 'r', status: 'succeeded' });
    const resumeCalls: string[] = [];
    const resumeParked = (s: Schedule): Promise<FireResult | null> => {
      resumeCalls.push(s.id);
      return Promise.resolve({ runId: s.lastRunId, status: 'succeeded' as const });
    };
    const harness = makeManualTimers();
    clock.value = new Date('2026-07-05T00:00:30.000Z');
    const daemon = new SchedulerDaemon({
      store,
      lock,
      fire,
      resumeParked,
      logger: silentLogger,
      timers: harness.timers,
      clock,
    });
    const reg = await store.register({ workflowName: 'demo', cronExpr: '*/5 * * * *' });
    if (!reg.isOk) throw new Error('register failed');
    // Simulate a prior fire that parked for confirmation.
    await store.markFire(reg.value.id, {
      lastFireAt: '2026-07-05T00:05:00.000Z',
      lastRunId: 'run-parked',
      lastStatus: 'pending-confirmation',
      nextFireAt: null,
    });
    await daemon.start(1);

    harness.fireInterval();
    await flush();

    expect(resumeCalls).toEqual([reg.value.id]);
    const got = await store.get(reg.value.id);
    if (!got.isOk || got.value === null) throw new Error('get failed');
    expect(got.value.lastStatus).toBe('succeeded');

    await daemon.stop();
  });

  it('leaves a parked schedule parked and does NOT re-fire it while awaiting consent', async () => {
    const lock = makeFakeLock();
    let fireCount = 0;
    const fire: FireFn = () => {
      fireCount++;
      return Promise.resolve({ runId: 'r', status: 'succeeded' });
    };
    // resumeParked returns null → still parked (no decision yet).
    const resumeParked = (): Promise<FireResult | null> => Promise.resolve(null);
    const harness = makeManualTimers();
    clock.value = new Date('2026-07-05T00:00:30.000Z');
    const daemon = new SchedulerDaemon({
      store,
      lock,
      fire,
      resumeParked,
      logger: silentLogger,
      timers: harness.timers,
      clock,
    });
    const reg = await store.register({ workflowName: 'demo', cronExpr: '*/5 * * * *' });
    if (!reg.isOk) throw new Error('register failed');
    await store.markFire(reg.value.id, {
      lastFireAt: '2026-07-05T00:05:00.000Z',
      lastRunId: 'run-parked',
      lastStatus: 'pending-confirmation',
      nextFireAt: null,
    });
    await daemon.start(1);

    // Advance well past several fire times — a parked schedule must never fire.
    clock.value = new Date('2026-07-05T01:00:00.000Z');
    harness.fireInterval();
    await flush();

    expect(fireCount).toBe(0);
    const got = await store.get(reg.value.id);
    if (!got.isOk || got.value === null) throw new Error('get failed');
    expect(got.value.lastStatus).toBe('pending-confirmation'); // unchanged

    await daemon.stop();
  });

  it('reports honest status via the lock probe and store', async () => {
    const lock = makeFakeLock();
    const fire: FireFn = () => Promise.resolve({ runId: 'r', status: 'succeeded' });
    const harness = makeManualTimers();
    clock.value = new Date('2026-07-05T00:00:00.000Z');
    const daemon = new SchedulerDaemon({
      store,
      lock,
      fire,
      logger: silentLogger,
      timers: harness.timers,
      clock,
    });

    const before = await daemon.status();
    expect(before.running).toBe(false);

    await store.register({ workflowName: 'demo', cronExpr: '*/5 * * * *' });
    await daemon.start(4242);

    const after = await daemon.status();
    expect(after.running).toBe(true);
    expect(after.pid).toBe(4242);
    expect(after.schedulesLoaded).toBe(1);
    expect(after.nextFires).toHaveLength(1);
    expect(after.nextFires[0]?.nextFireAt).toBe('2026-07-05T00:05:00.000Z');

    await daemon.stop();
  });
});

/** Flush pending microtasks + the daemon's setImmediate drain loop. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
