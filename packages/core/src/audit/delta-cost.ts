/**
 * What the page delta actually cost, read back off a recorded run.
 *
 * The replacement decision — whether `delta` should one day stand *instead of*
 * the full observation rather than beside it — needs three measurements: how
 * many bytes the bounded block costs, how many bytes the observation it rides
 * beside costs, and whether the model's next move is to call `browser_observe`
 * anyway. The first two ride the action tools' `details` payload into
 * `tool-calls.jsonl`; the third is a property of the *sequence* of calls, which
 * is why it needs a reader rather than a field.
 *
 * This module **claims nothing**. It reports what the artifact holds. A delta
 * that is a tenth the size of the observation is not a token saving until
 * total-turn evidence shows the model does not simply re-observe — which is
 * precisely the number `followUpObserveRate` exists to supply.
 *
 * A reader only: it changes no behavior and no policy, and adds no field to the
 * strict `ToolAuditEntry` schema.
 */

import type { ToolAuditEntryType } from '@yantra/protocol';

/** The tool a follow-up read would be. */
const OBSERVE_TOOL = 'browser_observe';

/** What one run's delta-bearing calls cost, and what the model did next. */
export interface DeltaCostSummary {
  /** Delta-bearing action calls in the run. */
  readonly calls: number;
  /** Total UTF-8 bytes of every emitted delta block. */
  readonly deltaBytesTotal: number;
  /** The largest single delta block, for checking the bound empirically. */
  readonly deltaBytesMax: number;
  /** Total UTF-8 bytes of the observations those calls shipped beside them. */
  readonly observationBytesTotal: number;
  /** `browser_observe` calls that immediately followed a delta-bearing action. */
  readonly followUpObserveCount: number;
  /**
   * `followUpObserveCount / calls`, or `0` when the run made no such calls.
   *
   * The measurement that decides whether a delta *replaces* an observation or
   * merely precedes a request for one.
   */
  readonly followUpObserveRate: number;
}

/**
 * Summarize delta cost over a run's tool-call entries.
 *
 * Reads `end`-phase entries in `seq` order: a `start` entry carries no output,
 * and a pair read out of order would attribute a follow-up observe to the wrong
 * predecessor.
 *
 * @param entries - Entries parsed from `tool-calls.jsonl`, in any order.
 */
export function summarizeDeltaCost(entries: readonly ToolAuditEntryType[]): DeltaCostSummary {
  const ends = entries
    .filter((entry) => entry.phase === 'end')
    .slice()
    .sort((left, right) => left.seq - right.seq);

  let calls = 0;
  let deltaBytesTotal = 0;
  let deltaBytesMax = 0;
  let observationBytesTotal = 0;
  let followUpObserveCount = 0;
  let previousCarriedDelta = false;

  for (const entry of ends) {
    if (entry.tool === OBSERVE_TOOL) {
      if (previousCarriedDelta) followUpObserveCount += 1;
      // An observe never carries a delta, so the next observe in a chain of
      // them is not a follow-up to an action.
      previousCarriedDelta = false;
      continue;
    }
    const details = detailsOf(entry.output_sanitized);
    const deltaBytes = numberOf(details?.delta_bytes);
    if (deltaBytes === null) {
      previousCarriedDelta = false;
      continue;
    }
    calls += 1;
    deltaBytesTotal += deltaBytes;
    deltaBytesMax = Math.max(deltaBytesMax, deltaBytes);
    observationBytesTotal += numberOf(details?.observation_bytes) ?? 0;
    previousCarriedDelta = true;
  }

  return {
    calls,
    deltaBytesTotal,
    deltaBytesMax,
    observationBytesTotal,
    followUpObserveCount,
    // Guarded rather than left to produce NaN: a run with no delta-bearing
    // calls has a rate of zero follow-ups, not an undefined one.
    followUpObserveRate: calls === 0 ? 0 : followUpObserveCount / calls,
  };
}

/** The `details` object a tool result carries, when it carries one. */
function detailsOf(output: unknown): Readonly<Record<string, unknown>> | null {
  if (output === null || typeof output !== 'object') return null;
  const details = (output as { readonly details?: unknown }).details;
  if (details === null || typeof details !== 'object' || Array.isArray(details)) return null;
  return details as Readonly<Record<string, unknown>>;
}

function numberOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
