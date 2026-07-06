/**
 * Pre-granted confirmation gateway (FEAT-021 TASK-004 resume path).
 *
 * When the daemon resumes a parked run whose confirmation a human already
 * granted via `yantra confirm <run-id> grant`, the executor re-enters the
 * flagged step and re-requests consent (FEAT-019: a grant is single-use and
 * step-scoped, so re-execution after resume re-requests). This gateway consumes
 * the human's *existing* on-disk grant to satisfy that re-request exactly once —
 * it does **not** create consent, it replays a decision a human already made.
 *
 * Safety: the daemon only ever constructs this gateway after
 * {@link resolveParkedRun} has confirmed the latest on-disk decision is
 * `granted`. The gateway grants **at most once** (single-use), then falls back
 * to `denied` — so it can never silently auto-approve a *second*, different
 * flagged step encountered later in the same resumed run. That second step would
 * itself park again on the next fire cycle.
 */

import type { ConfirmationRequest } from '@yantra/protocol';

import type { Logger } from '../browser/types.js';
import type { ConfirmationGateway, ConfirmationOutcome } from '../executor/confirmation-gateway.js';

/** Options for {@link PreGrantedConfirmationGateway}. */
export interface PreGrantedConfirmationGatewayOptions {
  readonly logger?: Logger;
}

/**
 * A {@link ConfirmationGateway} that replays a single prior human grant.
 *
 * The first `request()` returns `granted` (`decided_by: 'user_cli_confirm'` —
 * the grant originated from a human's `yantra confirm`); any subsequent request
 * in the same run returns `denied`, so a later, different flagged step is not
 * auto-approved.
 */
export class PreGrantedConfirmationGateway implements ConfirmationGateway {
  private consumed = false;
  private readonly logger: Logger | null;

  public constructor(opts: PreGrantedConfirmationGatewayOptions = {}) {
    this.logger = opts.logger ?? null;
  }

  public request(request: ConfirmationRequest): Promise<ConfirmationOutcome> {
    if (this.consumed) {
      // A second flagged step in the same resumed run — do NOT auto-approve.
      this.logger?.warn?.(
        { runId: request.run_id, stepId: request.step_id },
        'second confirmation in a resumed run — denying (only one prior grant to replay)',
      );
      return Promise.resolve({
        confirmation_id: request.confirmation_id,
        decision: 'denied' as const,
        decided_at: new Date().toISOString(),
        decided_by: 'user_cli_confirm' as const,
      });
    }

    this.consumed = true;
    this.logger?.info?.(
      { runId: request.run_id, stepId: request.step_id },
      'replaying prior human grant for resumed run',
    );
    return Promise.resolve({
      confirmation_id: request.confirmation_id,
      decision: 'granted' as const,
      decided_at: new Date().toISOString(),
      decided_by: 'user_cli_confirm' as const,
    });
  }
}
