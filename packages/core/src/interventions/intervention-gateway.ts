import type { ConfirmationRequest } from '@yantra/protocol';

import type { ConfirmationGateway, ConfirmationOutcome } from '../executor/confirmation-gateway.js';

import type { InterventionAuthority, RaiseOptions } from './authority.js';

/** Confirmation gateway backed by the live run's sole intervention authority. */
export class InterventionGateway implements ConfirmationGateway {
  public constructor(
    private readonly authority: InterventionAuthority,
    private readonly limits?: RaiseOptions,
  ) {}

  public async request(request: ConfirmationRequest): Promise<ConfirmationOutcome> {
    const decision = await this.authority.raise(request, this.limits);
    if (decision.expiryReason === 'unattended' && decision.blocker === undefined) {
      return {
        ...decision,
        blocker: `No one was available to approve ${request.action_kind} on ${request.host} within 15 minutes.`,
      };
    }
    return decision;
  }
}
