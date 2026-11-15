import type { ParkedDecisionClaim, ConfirmationRequest } from '@yantra/protocol';

import type { Logger } from '../browser/types.js';
import type {
  ConfirmationGateway,
  ConfirmationOutcome,
  GatewayDecision,
} from '../executor/confirmation-gateway.js';

import { bindingOf, bindingsMatch } from './binding.js';

export interface BoundResumeConfirmationGatewayOptions {
  readonly claim: ParkedDecisionClaim;
  readonly logger?: Logger;
  readonly now?: () => string;
}

/**
 * Replays one parked decision only when the resumed request is the exact
 * action the user approved. A second flagged step is always denied.
 */
export class BoundResumeConfirmationGateway implements ConfirmationGateway {
  private consumed = false;
  private readonly claim: ParkedDecisionClaim;
  private readonly logger: Logger | null;
  private readonly now: () => string;

  public constructor(options: BoundResumeConfirmationGatewayOptions) {
    this.claim = options.claim;
    this.logger = options.logger ?? null;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public request(request: ConfirmationRequest): Promise<ConfirmationOutcome> {
    if (this.consumed) {
      const decision = this.denied(
        request,
        'A second step needs approval; approve it in a new run.',
      );
      this.logger?.warn?.(
        { runId: request.run_id, stepId: request.step_id },
        'second confirmation in a resumed run — denying',
      );
      return Promise.resolve(decision);
    }
    this.consumed = true;

    if (this.claim.decision === 'denied') {
      return Promise.resolve(this.denied(request));
    }

    if (this.claim.binding.plan_digest === null || this.claim.binding.step_digest === null) {
      return Promise.resolve(
        this.denied(
          request,
          'This approval was recorded before approvals were tied to a step. Run the workflow again.',
        ),
      );
    }

    if (!bindingsMatch(this.claim.binding, bindingOf(request))) {
      return Promise.resolve(this.denied(request, 'The step changed since you approved it.'));
    }

    const decision: GatewayDecision = {
      confirmation_id: request.confirmation_id,
      decision: 'granted',
      decided_at: this.claim.decided_at,
      decided_by: this.claim.decided_by,
      replayed_at: this.now(),
    };
    this.logger?.info?.(
      { runId: request.run_id, stepId: request.step_id },
      'replaying bound parked grant',
    );
    return Promise.resolve(decision);
  }

  private denied(request: ConfirmationRequest, blocker?: string): GatewayDecision {
    return {
      confirmation_id: request.confirmation_id,
      decision: 'denied',
      decided_at: this.claim.decided_at,
      decided_by: this.claim.decided_by,
      ...(blocker === undefined ? {} : { blocker }),
    };
  }
}
