/**
 * Node-side candidate resolver.
 *
 * Validates and caps the ranked candidate chain received from the in-page overlay.
 * The ranking algorithm itself runs in-page (bundled into recorder-overlay.iife.js
 * from FEAT-004's `ranking.ts`) because it needs live DOM access. This module is
 * the Node-side validation and error-handling layer.
 *
 * If the in-page ranking fails, falls back to a single xpath-only candidate so
 * actions are always persisted — degraded but never lost.
 */

import type { RankedCandidate } from '@yantra/protocol';

const MAX_CANDIDATES = 5;

export interface RawInPageCandidate {
  candidate: unknown;
  score: number;
  rank_reason: string;
}

/**
 * Validates and normalizes the raw candidate chain from the in-page overlay.
 *
 * @param raw - Candidate array received from the in-page binding payload
 * @param xpathFallback - xpath_for_debug from the ElementDescriptor (last resort)
 * @returns Up to 5 validated `RankedCandidate` objects, never empty
 */
export function normalizeCandidateChain(
  raw: RawInPageCandidate[] | undefined | null,
  xpathFallback: string,
): RankedCandidate[] {
  if (!raw || raw.length === 0) {
    return fallbackChain(xpathFallback);
  }

  const validated: RankedCandidate[] = [];
  for (const entry of raw.slice(0, MAX_CANDIDATES)) {
    if (!isValidCandidate(entry)) continue;
    validated.push({
      candidate: entry.candidate as RankedCandidate['candidate'],
      score: entry.score,
      rank_reason: entry.rank_reason,
    });
  }

  if (validated.length === 0) {
    return fallbackChain(xpathFallback);
  }

  return validated;
}

function isValidCandidate(raw: RawInPageCandidate): boolean {
  if (typeof raw !== 'object' || raw === null) return false;
  if (typeof raw.score !== 'number' || isNaN(raw.score)) return false;
  if (typeof raw.rank_reason !== 'string') return false;
  if (typeof raw.candidate !== 'object' || raw.candidate === null) return false;
  const c = raw.candidate as Record<string, unknown>;
  if (typeof c.kind !== 'string') return false;
  return true;
}

function fallbackChain(xpathFallback: string): RankedCandidate[] {
  return [
    {
      candidate: { kind: 'xpath', expression: xpathFallback },
      score: 0.1,
      rank_reason: 'absolute XPath (last resort — in-page ranking unavailable)',
    },
  ];
}
