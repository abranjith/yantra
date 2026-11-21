import type { ConfirmationRequest } from '@yantra/protocol';

import type {
  ConfirmationGateway,
  ConfirmationOutcome,
  GatewayDecision,
} from '../executor/confirmation-gateway.js';

import type { InterventionAuthority, RaiseOptions } from './authority.js';
import type { RunBindableGateway, RunInterventionBinding } from './run-interventions.js';

export type ConfirmationAnswer = 'granted' | 'denied' | GatewayDecision;

export interface AuthorityConnectorGatewayOptions {
  readonly authority:
    InterventionAuthority | ((request: ConfirmationRequest) => InterventionAuthority);
  readonly answer: (
    request: ConfirmationRequest,
    signal: AbortSignal,
  ) => Promise<ConfirmationAnswer>;
  readonly limits?: RaiseOptions | ((request: ConfirmationRequest) => RaiseOptions);
  /**
   * Binds the authority to a run's socket and event log when the run owner
   * opens them (REV-002). Usually the `RunInterventions` that supplies
   * `authority`.
   */
  readonly runs?: RunBindableGateway;
}

/** Connects a prompt/socket answerer to the live decision authority. */
export class AuthorityConnectorConfirmationGateway
  implements ConfirmationGateway, RunBindableGateway
{
  public constructor(private readonly options: AuthorityConnectorGatewayOptions) {}

  public attachRun(runId: string, binding: RunInterventionBinding): void {
    this.options.runs?.attachRun(runId, binding);
  }

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
