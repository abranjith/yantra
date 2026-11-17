import type { ConfirmationRequest } from '@yantra/protocol';

import type {
  ConfirmationGateway,
  ConfirmationOutcome,
  GatewayDecision,
} from '../executor/confirmation-gateway.js';

import type { InterventionAuthority, RaiseOptions } from './authority.js';

export type ConfirmationAnswer = 'granted' | 'denied' | GatewayDecision;

export interface AuthorityConnectorGatewayOptions {
  readonly authority:
    InterventionAuthority | ((request: ConfirmationRequest) => InterventionAuthority);
  readonly answer: (
    request: ConfirmationRequest,
    signal: AbortSignal,
  ) => Promise<ConfirmationAnswer>;
  readonly limits?: RaiseOptions | ((request: ConfirmationRequest) => RaiseOptions);
}

/** Connects a prompt/socket answerer to the live decision authority. */
export class AuthorityConnectorConfirmationGateway implements ConfirmationGateway {
  public constructor(private readonly options: AuthorityConnectorGatewayOptions) {}

  public request(request: ConfirmationRequest): Promise<ConfirmationOutcome> {
    const controller = new AbortController();
    const authority =
      typeof this.options.authority === 'function'
        ? this.options.authority(request)
        : this.options.authority;
    const limits =
      typeof this.options.limits === 'function'
        ? this.options.limits(request)
        : (this.options.limits ?? {});
    const waiting = authority.raise(request, limits);

    void this.options
      .answer(request, controller.signal)
      .then((answer) => {
        const decision = typeof answer === 'string' ? answer : answer.decision;
        return authority.answer({
          interventionId: request.confirmation_id,
          decision: decision === 'granted' ? 'granted' : 'denied',
          decidedBy: typeof answer === 'string' ? 'user_interactive' : answer.decided_by,
        });
      })
      .catch(() => undefined);

    return waiting.finally(() => controller.abort('confirmation-settled'));
  }
}
