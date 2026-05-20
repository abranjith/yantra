import { EthicsRefusedError } from '../executor/errors.js';
import type { EthicsGate } from '../executor/types.js';

import type { BlocklistImpl } from './blocklist.js';
import type { RateLimiterImpl } from './rate-limiter.js';
import type { RobotsCacheImpl } from './robots.js';

export interface EthicsGateOptions {
  readonly enforceRobotsTxt?: boolean;
}

/**
 * Composite ethics gate: blocklist → optional robots.txt → rate-limiter.
 *
 * Blocklist is checked first (cheap, synchronous pattern match).
 * Robots.txt is checked second only when enforcement is enabled.
 * Rate-limiter is last — it may sleep to acquire a token.
 *
 * Throws EthicsRefusedError on any disallow.
 * Blocklist + rate-limiter remain non-bypassable.
 */
export class EthicsGateImpl implements EthicsGate {
  private readonly enforceRobotsTxt: boolean;

  constructor(
    private readonly blocklist: BlocklistImpl,
    private readonly robots: RobotsCacheImpl,
    private readonly rateLimiter: RateLimiterImpl,
    private readonly userAgent: string,
    options?: EthicsGateOptions,
  ) {
    this.enforceRobotsTxt = options?.enforceRobotsTxt ?? false;
  }

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

    // 2. Robots.txt — opt-in check, cached and fail-closed when enabled
    if (this.enforceRobotsTxt) {
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
