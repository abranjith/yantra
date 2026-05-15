import type { EthicsGate } from '../executor/types.js';
import { EthicsRefusedError } from '../executor/errors.js';
import type { BlocklistImpl } from './blocklist.js';
import type { RobotsCacheImpl } from './robots.js';
import type { RateLimiterImpl } from './rate-limiter.js';

/**
 * Composite ethics gate: blocklist → robots.txt → rate-limiter.
 *
 * Blocklist is checked first (cheap, synchronous pattern match).
 * Robots.txt is checked second (cached, one network fetch per host per 24h).
 * Rate-limiter is last — it may sleep to acquire a token.
 *
 * Throws EthicsRefusedError on any disallow.
 * The gate is NON-BYPASSABLE in MVP — no config flag disables it.
 */
export class EthicsGateImpl implements EthicsGate {
  constructor(
    private readonly blocklist: BlocklistImpl,
    private readonly robots: RobotsCacheImpl,
    private readonly rateLimiter: RateLimiterImpl,
    private readonly userAgent: string,
  ) {}

  async check(
    url: string,
    action: 'navigate' | 'fetch',
    ctx: { taskId: string; runId: string; stepId: string },
  ): Promise<void> {
    const host = extractHost(url);

    // 1. Blocklist — synchronous, loudest refusal
    const blockCategory = this.blocklist.match(host);
    if (blockCategory !== null) {
      throw new EthicsRefusedError(
        {
          host,
          rule: blockCategory,
          reason: `Host is in the ${blockCategory} blocklist`,
          source: 'blocklist',
        },
        ctx,
      );
    }

    // 2. Robots.txt — cached, fail-closed on errors
    const robotsReason = await this.robots.reasonIfDisallowed(url, this.userAgent);
    if (robotsReason !== null) {
      throw new EthicsRefusedError(
        {
          host,
          rule: 'robots.txt',
          reason: robotsReason,
          source: 'robots',
        },
        ctx,
      );
    }

    // 3. Rate-limiter — token bucket, may sleep
    await this.rateLimiter.acquire(host);
  }
}

function extractHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
