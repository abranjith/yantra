import type { Clock } from '../executor/types.js';
import type { RateLimitStore } from '../index-db/rate-limit-store.js';

import type { HostRateLimit } from './config.js';

/**
 * In-process per-host token bucket rate limiter.
 *
 * By default state lives for the duration of one limiter instance. When an
 * optional {@link RateLimitStore} is supplied (FEAT-018 TASK-006), each host's
 * bucket is **loaded from the store on first use and flushed write-through on
 * every token consumption**, so the budget survives process restarts — a fresh
 * `yantra` invocation can no longer reset a host to a full burst. With no store,
 * behavior is identical to the MVP (executor tests unaffected).
 *
 * A fake `Clock` can be injected for tests to avoid real sleeping.
 */
export class RateLimiterImpl {
  private readonly buckets = new Map<string, TokenBucket>();

  constructor(
    private readonly defaultBudget: HostRateLimit,
    private readonly overrides: ReadonlyMap<string, HostRateLimit>,
    private readonly clock: Clock,
    private readonly store?: RateLimitStore,
  ) {}

  /**
   * Awaits until a token is available for the host.
   * Returns the wait duration in ms.
   */
  async acquire(host: string): Promise<number> {
    const budget = this.budgetFor(host);
    let bucket = this.buckets.get(host);
    if (!bucket) {
      bucket = new TokenBucket(
        budget.tokensPerSecond,
        budget.burst,
        this.clock,
        this.restore(host),
      );
      this.buckets.set(host, bucket);
    }
    const wait = await bucket.acquire();

    // Write-through: persist the post-consumption bucket state so a restart
    // resumes from here rather than a fresh burst.
    if (this.store) {
      const snapshot = bucket.snapshot();
      this.store.save({
        host,
        tokens: snapshot.tokens,
        windowStartedAt: new Date(snapshot.lastRefillMs).toISOString(),
      });
    }

    return wait;
  }

  budgetFor(host: string): HostRateLimit {
    return this.overrides.get(host) ?? this.defaultBudget;
  }

  /** Loads a host's persisted bucket state (if a store is wired), or null. */
  private restore(host: string): BucketState | null {
    if (!this.store) {
      return null;
    }
    const persisted = this.store.load(host);
    if (persisted === null) {
      return null;
    }
    const lastRefillMs = Date.parse(persisted.windowStartedAt);
    if (Number.isNaN(lastRefillMs)) {
      return null;
    }
    return { tokens: persisted.tokens, lastRefillMs };
  }
}

/** Serializable token-bucket state (persisted across restarts). */
interface BucketState {
  readonly tokens: number;
  readonly lastRefillMs: number;
}

class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly tokensPerSecond: number,
    private readonly burst: number,
    private readonly clock: Clock,
    restore: BucketState | null = null,
  ) {
    if (restore !== null) {
      // Resume from persisted state; clamp to the current burst ceiling in case
      // the configured budget shrank between runs.
      this.tokens = Math.min(burst, Math.max(0, restore.tokens));
      this.lastRefill = restore.lastRefillMs;
    } else {
      this.tokens = burst;
      this.lastRefill = clock.now();
    }
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

  /** Returns the current serializable state for persistence. */
  snapshot(): BucketState {
    return { tokens: this.tokens, lastRefillMs: this.lastRefill };
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
