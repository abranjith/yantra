/** Best-effort helpers for observation-only domain ranking. */

import type { DomainRankReason, DomainRankSignal, RankSignalSink } from './types.js';

/** Extracts a hostname from a URL, returning null for malformed input. */
export function domainFromUrl(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** Maps a source-processing failure stage to its ranking reason. */
export function rankReasonForFailureStage(
  stage: 'fetch' | 'extract' | 'blocked',
): DomainRankReason {
  switch (stage) {
    case 'fetch':
      return 'fetch_failed';
    case 'extract':
      return 'extract_failed';
    case 'blocked':
      return 'blocked';
  }
}

/**
 * Delivers a signal without allowing a faulty sink to affect its owning flow.
 * This boundary guard enforces the port contract even for test/user adapters
 * that accidentally throw.
 */
export function safeRecordRankSignal(
  sink: RankSignalSink | null | undefined,
  signal: DomainRankSignal,
): void {
  if (sink === null || sink === undefined) {
    return;
  }
  try {
    sink.record(signal);
  } catch {
    // Ranking is observation-only; the production sink reports its own errors.
  }
}
