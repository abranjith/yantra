/**
 * Parked-run resolver (FEAT-021 TASK-004 poll-pickup).
 *
 * When a scheduled fire hits a `requires_confirmation` step it parks (the
 * {@link DaemonConfirmationGateway} returns `parked`, leaving the request
 * pending). A human later resolves it out-of-band with
 * `yantra confirm <run-id> grant|deny`, which appends a decision to the run's
 * `confirmations.jsonl`. This resolver — run on the daemon's poll — detects that
 * decision and finishes the run **unattended-safely**:
 *   - `granted` → resume the run from its checkpoint (the pre-step pause point
 *     makes this exact),
 *   - `denied` / `timed_out` → the run is finalized as a handoff abort (already
 *     reported); the schedule status flips off `pending-confirmation`.
 *
 * Crucially there is still **no auto-grant**: this only *acts on* a decision a
 * human already made via `yantra confirm` (plan §6).
 */

import type { ConfirmationDecision } from '@yantra/protocol';

import type { Logger } from '../browser/types.js';
import type { LastFireStatus } from '../index-db/schedule-store.js';

import type { FireResult } from './daemon.js';

/** Reads the latest confirmation decision for a run (mockable in tests). */
export interface ConfirmationDecisionReader {
  latestDecision(runId: string): Promise<ConfirmationDecision | null>;
}

/** Resumes a run from its checkpoint and reports the settled status. */
export interface ResumeDriver {
  resume(runId: string): Promise<{ status: LastFireStatus; runId: string }>;
}

/** Dependencies for {@link resolveParkedRun}. */
export interface ParkedResolverDeps {
  /** Reads the run's `confirmations.jsonl` for the latest decision. */
  readonly reader: ConfirmationDecisionReader;
  /** Resumes the run when the decision is `granted`. */
  readonly resume: ResumeDriver;
  readonly logger: Logger;
}

/**
 * Resolves a parked run given its run id.
 *
 * @returns The settled {@link FireResult} once a decision has been acted on, or
 *   `null` when the run is still parked (no decision yet, or no run id).
 */
export async function resolveParkedRun(
  runId: string | null,
  deps: ParkedResolverDeps,
): Promise<FireResult | null> {
  if (runId === null || runId.length === 0) {
    return null;
  }

  const decision = await deps.reader.latestDecision(runId);
  if (decision === null) {
    return null; // still parked — no human decision yet
  }

  if (decision.decision === 'granted') {
    deps.logger.info({ runId }, 'parked run granted out-of-band — resuming');
    const outcome = await deps.resume.resume(runId);
    return { runId: outcome.runId, status: outcome.status };
  }

  // Denied or timed_out: the run is already finalized as a handoff abort; just
  // flip the schedule off pending-confirmation (never auto-retried).
  deps.logger.info(
    { runId, decision: decision.decision },
    'parked run denied out-of-band — finalizing as handoff',
  );
  return { runId, status: 'handoff' };
}
