/**
 * `RateLimitStore` — cross-run persistence of the ethics gate's per-host token
 * buckets (feature spec §2, folding in the deferred TODO.md §Performance item).
 *
 * The MVP rate limiter held bucket state in-process only, so a fresh `yantra`
 * invocation started every host with a full burst — a restart could sidestep a
 * per-host budget. Backing the buckets with this store lets the token state
 * survive process restarts (write-through on each token consumption; WAL makes
 * the write cheap). An absent store preserves the original in-process-only
 * behavior exactly, so the executor tests are unaffected.
 */

import type { Logger } from '../browser/types.js';

import type { DatabaseSync } from './sqlite.js';

/** Persisted token-bucket state for one host. */
export interface RateLimitState {
  /** Host the bucket governs. */
  readonly host: string;
  /** Remaining tokens at {@link windowStartedAt}. */
  readonly tokens: number;
  /** ISO-8601 timestamp of the last refill (the bucket's clock anchor). */
  readonly windowStartedAt: string;
}

/**
 * Repository interface over the `rate_limits` table. Synchronous (node:sqlite is
 * synchronous) so the rate limiter can load/flush inside its token loop without
 * awaiting.
 */
export interface RateLimitStore {
  /** Loads a host's persisted bucket state, or null when none is stored. */
  load(host: string): RateLimitState | null;
  /** Write-through persists a host's current bucket state. */
  save(state: RateLimitState): void;
}

/** Constructor dependencies for {@link SqliteRateLimitStore}. */
export interface SqliteRateLimitStoreDeps {
  readonly db: DatabaseSync;
  readonly logger?: Logger;
}

/** SQLite-backed {@link RateLimitStore}. Errors degrade to no-op (best-effort). */
export class SqliteRateLimitStore implements RateLimitStore {
  private readonly db: DatabaseSync;
  private readonly logger: Logger | null;

  public constructor(deps: SqliteRateLimitStoreDeps) {
    this.db = deps.db;
    this.logger = deps.logger ?? null;
  }

  public load(host: string): RateLimitState | null {
    try {
      const row = this.db
        .prepare('SELECT host, tokens, window_started_at FROM rate_limits WHERE host = ?')
        .get(host) as { host: string; tokens: number; window_started_at: string } | undefined;
      if (row === undefined) {
        return null;
      }
      return { host: row.host, tokens: Number(row.tokens), windowStartedAt: row.window_started_at };
    } catch (error) {
      this.logger?.debug?.(
        { host, error: error instanceof Error ? error.message : String(error) },
        'rate-limit load failed; treating as unpersisted',
      );
      return null;
    }
  }

  public save(state: RateLimitState): void {
    try {
      this.db
        .prepare(
          `INSERT INTO rate_limits (host, tokens, window_started_at)
           VALUES (?, ?, ?)
           ON CONFLICT(host) DO UPDATE SET
             tokens = excluded.tokens,
             window_started_at = excluded.window_started_at`,
        )
        .run(state.host, state.tokens, state.windowStartedAt);
    } catch (error) {
      this.logger?.debug?.(
        { host: state.host, error: error instanceof Error ? error.message : String(error) },
        'rate-limit save failed; state stays in-process only',
      );
    }
  }
}
