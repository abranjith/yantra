/** Best-effort helpers for observation-only domain ranking. */

import type { SourceFailure } from '../synthesis/types.js';

import type { DomainRankReason, DomainRankSignal, RankSignalSink } from './types.js';

/** Extracts a hostname from a URL, returning null for malformed input. */
export function domainFromUrl(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * Maps a source-processing failure stage to its ranking reason, or null when
 * the failure was Yantra's own refusal and says nothing about the site.
 *
 * A spent navigation/host budget (`budget`) or an outbound URL-policy refusal
 * (`policy`) is a limit the run imposed on itself. Recording either as a
 * negative signal penalized two domains in cross-run ranking for a budget the
 * run had exhausted (FEAT-048 G6). Callers skip the signal on null.
 */
export function rankReasonForFailureStage(stage: SourceFailure['stage']): DomainRankReason | null {
  switch (stage) {
    case 'fetch':
      return 'fetch_failed';
    case 'extract':
      return 'extract_failed';
    case 'blocked':
      return 'blocked';
    case 'budget':
    case 'policy':
      return null;
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
