import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RateLimiterImpl } from '../../src/ethics/rate-limiter.js';
import type { Clock } from '../../src/executor/types.js';
import { runMigrations } from '../../src/index-db/migrations.js';
import { SqliteRateLimitStore } from '../../src/index-db/rate-limit-store.js';
import { DatabaseSync } from '../../src/index-db/sqlite.js';

function makeClock(startMs = 0): { clock: Clock; advance: (ms: number) => void } {
  let now = startMs;
  const timers = new Map<number, { fn: () => void; fireAt: number }>();
  let idCounter = 1;

  const advance = (ms: number) => {
    now += ms;
    for (const [id, t] of timers) {
      if (t.fireAt <= now) {
        timers.delete(id);
        t.fn();
      }
    }
  };

  const clock: Clock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = idCounter++ as unknown as ReturnType<typeof globalThis.setTimeout>;
      timers.set(id as unknown as number, { fn, fireAt: now + ms });
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(id as unknown as number);
    },
  };

  return { clock, advance };
}

describe('@no-llm cross-run rate-limit persistence', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it('round-trips bucket state through the store', () => {
    const store = new SqliteRateLimitStore({ db });
    expect(store.load('example.com')).toBeNull();
    store.save({ host: 'example.com', tokens: 1.5, windowStartedAt: '2026-07-01T00:00:00.000Z' });
    expect(store.load('example.com')).toEqual({
      host: 'example.com',
      tokens: 1.5,
      windowStartedAt: '2026-07-01T00:00:00.000Z',
    });
  });

  it('a restarted limiter resumes the drained bucket instead of a fresh burst', async () => {
    const store = new SqliteRateLimitStore({ db });
    const { clock } = makeClock(0);

    // Process 1: drain all 3 burst tokens.
    const limiter1 = new RateLimiterImpl({ tokensPerSecond: 1, burst: 3 }, new Map(), clock, store);
    await limiter1.acquire('example.com');
    await limiter1.acquire('example.com');
    await limiter1.acquire('example.com');

    const persisted = store.load('example.com');
    expect(persisted).not.toBeNull();
    expect(persisted!.tokens).toBeLessThan(1);

    // Process 2 (restart, same clock time): must wait — no free burst.
    const { clock: clock2, advance } = makeClock(0);
    const limiter2 = new RateLimiterImpl(
      { tokensPerSecond: 1, burst: 3 },
      new Map(),
      clock2,
      store,
    );
    const pending = limiter2.acquire('example.com');
    advance(1010); // one token refills after ~1s
    const wait = await pending;
    expect(wait).toBeGreaterThan(0);
  });

  it('regenerates tokens across a restart per the elapsed window', async () => {
    const store = new SqliteRateLimitStore({ db });
    const { clock } = makeClock(0);

    const limiter1 = new RateLimiterImpl({ tokensPerSecond: 1, burst: 3 }, new Map(), clock, store);
    await limiter1.acquire('host.test');
    await limiter1.acquire('host.test');
    await limiter1.acquire('host.test'); // drained at t=0

    // Restart 2s later: 2 tokens should have regenerated, so acquire is immediate.
    const { clock: clock2 } = makeClock(2000);
    const limiter2 = new RateLimiterImpl(
      { tokensPerSecond: 1, burst: 3 },
      new Map(),
      clock2,
      store,
    );
    const wait = await limiter2.acquire('host.test');
    expect(wait).toBe(0);
  });

  it('a store-less limiter behaves exactly as before (regression)', async () => {
    const { clock } = makeClock(0);
    const limiter = new RateLimiterImpl({ tokensPerSecond: 1, burst: 2 }, new Map(), clock);
    expect(await limiter.acquire('example.com')).toBe(0);
    expect(await limiter.acquire('example.com')).toBe(0);
    // Nothing was persisted (no store).
    const store = new SqliteRateLimitStore({ db });
    expect(store.load('example.com')).toBeNull();
  });
});
