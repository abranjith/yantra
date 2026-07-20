/**
 * Observation-only domain-ranking port shared by deterministic and agentic
 * web flows. The port keeps SQLite out of LLM-adjacent dependency graphs.
 *
 * Recording is fire-and-forget: callers must isolate a misbehaving sink so a
 * ranking failure can never alter or fail the owning run.
 */

/** Why a domain received a ranking observation. */
export type DomainRankReason = 'search_result' | 'fetch_failed' | 'extract_failed' | 'blocked';

/** One domain-ranking observation. */
export interface DomainRankSignal {
  /** Raw hostname; the receiving store is responsible for normalization. */
  readonly domain: string;
  readonly delta: 1 | -1;
  readonly reason: DomainRankReason;
}

/** Fire-and-forget sink for domain-ranking observations. */
export interface RankSignalSink {
  /** Records one observation. Implementations must never throw. */
  record(signal: DomainRankSignal): void;
}
