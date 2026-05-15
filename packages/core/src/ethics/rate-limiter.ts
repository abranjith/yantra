import type { Clock } from '../executor/types.js';

import type { HostRateLimit } from './config.js';

/**
 * In-process per-host token bucket rate limiter.
 *
 * State lives for the duration of one executor instance — no cross-process
 * or cross-run persistence in MVP (per plan §6 deliberate scoping decision).
 * A fake `Clock` can be injected for tests to avoid real sleeping.
 */
export class RateLimiterImpl {
  private readonly buckets = new Map<string, TokenBucket>();

  constructor(
    private readonly defaultBudget: HostRateLimit,
    private readonly overrides: ReadonlyMap<string, HostRateLimit>,
    private readonly clock: Clock,
  ) {}

  /**
   * Awaits until a token is available for the host.
   * Returns the wait duration in ms.
   */
  async acquire(host: string): Promise<number> {
    const budget = this.budgetFor(host);
    let bucket = this.buckets.get(host);
    if (!bucket) {
      bucket = new TokenBucket(budget.tokensPerSecond, budget.burst, this.clock);
      this.buckets.set(host, bucket);
    }
    return bucket.acquire();
  }

  budgetFor(host: string): HostRateLimit {
    return this.overrides.get(host) ?? this.defaultBudget;
  }
}

class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly tokensPerSecond: number,
    private readonly burst: number,
    private readonly clock: Clock,
  ) {
    this.tokens = burst;
    this.lastRefill = clock.now();
  }

  async acquire(): Promise<number> {
    const startWait = this.clock.now();

    while (true) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return this.clock.now() - startWait;
      }
      // Calculate wait time until next token available
      const waitMs = Math.ceil((1 / this.tokensPerSecond) * 1000);
      await sleep(waitMs, this.clock);
    }
  }

  private refill(): void {
    const now = this.clock.now();
    const elapsed = (now - this.lastRefill) / 1000;
    const newTokens = elapsed * this.tokensPerSecond;
    this.tokens = Math.min(this.burst, this.tokens + newTokens);
    this.lastRefill = now;
  }
}

function sleep(ms: number, clock: Clock): Promise<void> {
  return new Promise((resolve) => {
    const handle = clock.setTimeout(resolve, ms);
    if (typeof handle.unref === 'function') {
      handle.unref();
    }
  });
}
