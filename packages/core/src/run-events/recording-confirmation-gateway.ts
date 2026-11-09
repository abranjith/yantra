/**
 * `RecordingConfirmationGateway` (FEAT-063): every consent wait leaves a
 * surface-neutral record in `run-events.jsonl`.
 *
 * - Before the wait: `intervention_raised`, with the sanitized request and the
 *   absolute instant the wait ends (or null when it waits indefinitely, or
 *   parks).
 * - After a decision: `intervention_resolved`, with the decision, its
 *   provenance and when it was made.
 * - A parked request (the daemon) stays raised: it is resolved out of band.
 * - A gateway that throws (abort, wall clock) records nothing further; the
 *   run's `run_outcome` records how it ended.
 *
 * Both events are intervention kinds, so the log syncs immediately after each.
 * The decorator adds no fields: requests and decisions are already sanitized
 * protocol data, and there is no agent decider.
 */

import type { ConfirmationDecision, ConfirmationRequest } from '@yantra/protocol';

import type { ConfirmationOutcome, ConfirmationParked } from '../executor/confirmation-gateway.js';

import type { RunEventStream } from './stream.js';

/** Anything that resolves a confirmation request, as the executor and the agent bridge do. */
export interface ConfirmationRequester<Outcome extends ConfirmationOutcome> {
  request(request: ConfirmationRequest): Promise<Outcome>;
}

/** Options for {@link RecordingConfirmationGateway}. */
export interface RecordingConfirmationOptions {
  /**
   * The absolute instant the wait for `request` ends, or null for an
   * indefinite wait. Defaults to {@link requestDeadline}.
   */
  readonly deadlineFor?: (request: ConfirmationRequest) => string | null;
  /** Timestamp source for the events' `at`. */
  readonly now?: () => string;
}

/**
 * The deadline a request itself states: `requested_at + timeout_ms`, or null
 * when it has no timeout.
 */
export function requestDeadline(request: ConfirmationRequest): string | null {
  if (request.timeout_ms === null) return null;
  const start = Date.parse(request.requested_at);
  if (Number.isNaN(start)) return null;
  return new Date(start + request.timeout_ms).toISOString();
}

function isParkedOutcome(outcome: ConfirmationOutcome): outcome is ConfirmationParked {
  return (outcome as ConfirmationParked).kind === 'parked';
}

export class RecordingConfirmationGateway<
  Outcome extends ConfirmationOutcome = ConfirmationOutcome,
> implements ConfirmationRequester<Outcome> {
  private readonly deadlineFor: (request: ConfirmationRequest) => string | null;
  private readonly now: () => string;

  public constructor(
    private readonly inner: ConfirmationRequester<Outcome>,
    private readonly stream: RunEventStream,
    options: RecordingConfirmationOptions = {},
  ) {
    this.deadlineFor = options.deadlineFor ?? requestDeadline;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public async request(request: ConfirmationRequest): Promise<Outcome> {
    this.stream.emit({
      kind: 'intervention_raised',
      intervention_id: request.confirmation_id,
      intervention_kind: 'confirmation',
      request,
      deadline_at: this.deadlineFor(request),
      at: this.now(),
    });
    const outcome = await this.inner.request(request);
    if (isParkedOutcome(outcome)) return outcome;
    const decision: ConfirmationDecision = outcome;
    this.stream.emit({
      kind: 'intervention_resolved',
      intervention_id: request.confirmation_id,
      decision: decision.decision,
      decided_by: decision.decided_by,
      decided_at: decision.decided_at,
      at: this.now(),
    });
    return outcome;
  }
}
