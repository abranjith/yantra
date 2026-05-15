import { describe, expect, it, vi } from 'vitest';

import { RateLimiterImpl } from '../../src/ethics/rate-limiter.js';
import type { Clock } from '../../src/executor/types.js';

function makeClock(startMs = 0): { clock: Clock; advance: (ms: number) => void } {
  let now = startMs;
  const timers: Map<number, { fn: () => void; fireAt: number }> = new Map();
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

describe('@no-llm RateLimiterImpl', () => {
  it('returns a wait of 0 when burst tokens are available', async () => {
    const { clock } = makeClock();
    const limiter = new RateLimiterImpl(
      { tokensPerSecond: 1, burst: 2 },
      new Map(),
      clock,
    );

    const wait = await limiter.acquire('example.com');
    expect(wait).toBe(0);
  });

  it('drains burst tokens without waiting', async () => {
    const { clock } = makeClock();
    const limiter = new RateLimiterImpl(
      { tokensPerSecond: 1, burst: 2 },
      new Map(),
      clock,
    );

    const w1 = await limiter.acquire('example.com');
    const w2 = await limiter.acquire('example.com');
    expect(w1).toBe(0);
    expect(w2).toBe(0);
  });

  it('waits after burst is exhausted and token refills', async () => {
    const { clock, advance } = makeClock();
    const limiter = new RateLimiterImpl(
      { tokensPerSecond: 1, burst: 1 },
      new Map(),
      clock,
    );

    // Consume the 1 burst token immediately
    await limiter.acquire('example.com');

    // Third acquire must wait — advance clock while acquire is pending
    const acquirePromise = limiter.acquire('example.com');
    advance(1010); // refill 1 token after 1s
    const wait = await acquirePromise;
    expect(wait).toBeGreaterThan(0);
  });

  it('uses per-host override budget', async () => {
    const { clock } = makeClock();
    const overrides = new Map([['fast.com', { tokensPerSecond: 10, burst: 5 }]]);
    const limiter = new RateLimiterImpl(
      { tokensPerSecond: 1, burst: 1 },
      overrides,
      clock,
    );

    expect(limiter.budgetFor('fast.com')).toEqual({ tokensPerSecond: 10, burst: 5 });
    expect(limiter.budgetFor('slow.com')).toEqual({ tokensPerSecond: 1, burst: 1 });
  });

  it('maintains separate buckets per host', async () => {
    const { clock } = makeClock();
    const limiter = new RateLimiterImpl(
      { tokensPerSecond: 1, burst: 1 },
      new Map(),
      clock,
    );

    // Exhaust host A's bucket
    await limiter.acquire('a.com');

    // Host B's bucket is fresh
    const waitB = await limiter.acquire('b.com');
    expect(waitB).toBe(0);
  });

  it('does not refill beyond burst capacity', async () => {
    const { clock, advance } = makeClock();
    const limiter = new RateLimiterImpl(
      { tokensPerSecond: 1, burst: 2 },
      new Map(),
      clock,
    );

    // Wait a very long time — tokens should cap at burst=2
    advance(10_000);

    // Both acquires should succeed immediately (burst=2 cap prevents infinite build-up)
    const w1 = await limiter.acquire('example.com');
    const w2 = await limiter.acquire('example.com');
    expect(w1).toBe(0);
    expect(w2).toBe(0);

    // Third would need to wait
    const acquireP = limiter.acquire('example.com');
    advance(1010);
    const w3 = await acquireP;
    expect(w3).toBeGreaterThan(0);
  });
});
