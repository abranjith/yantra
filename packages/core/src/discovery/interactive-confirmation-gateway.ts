/**
 * Interactive terminal confirmation gateway (FEAT-020 TASK-004).
 *
 * `yantra do` is a single, long-running foreground process — unlike
 * `yantra run` (whose confirmation wiring is deferred; see feature spec
 * DEVIATION note), discovery can resolve a consent request **synchronously,
 * in-process**, by rendering a consent card and blocking on a terminal
 * prompt. This is "same protocol, two connectors" (plan §7): the daemon
 * (FEAT-021) will implement the same `ConfirmationGateway` interface via a
 * notification + `yantra confirm`; this is the CLI's own connector.
 *
 * Every decision is `decided_by: 'user_interactive'` — there is no
 * auto-grant path. `--yes-to nothing` (the only accepted value, enforced at
 * the CLI flag layer) documents that nothing can ever be auto-approved here.
 */

import { join } from 'node:path';

import type { ConfirmationDecision, ConfirmationRequest } from '@yantra/protocol';
import prompts from 'prompts';

import { runsRoot } from '../browser/paths.js';
import type { ConfirmationGateway } from '../executor/confirmation-gateway.js';
import {
  AuthorityConnectorConfirmationGateway,
  InterventionAuthority,
  InterventionLog,
  UnattendedCeilingClock,
  type InterventionAuthority as InterventionAuthorityType,
} from '../interventions/index.js';

/** Minimal stdout sink so tests can capture the rendered consent card. */
export interface ConsentRenderSink {
  write(text: string): void;
}

/** Options for {@link InteractiveConfirmationGateway}. */
export interface InteractiveConfirmationGatewayOptions {
  readonly sink?: ConsentRenderSink;
  /** Injected prompt function; defaults to the real `prompts` package. */
  readonly promptFn?: typeof prompts;
  /** Optional authority supplied by a run owner. */
  readonly authority?: InterventionAuthorityType;
}

/**
 * Renders a consent card to the sink and blocks on a y/n terminal prompt.
 * A non-TTY / declined prompt (including Ctrl+C, which `prompts` resolves as
 * `undefined`) is treated as **denied** — fail-closed, never fail-open.
 */
export class InteractiveConfirmationGateway implements ConfirmationGateway {
  private readonly sink: ConsentRenderSink;
  private readonly promptFn: typeof prompts;
  private readonly suppliedAuthority: InterventionAuthorityType | null;
  private readonly authorities = new Map<string, InterventionAuthorityType>();

  public constructor(opts: InteractiveConfirmationGatewayOptions = {}) {
    this.sink = opts.sink ?? { write: (text: string) => process.stdout.write(text) };
    this.promptFn = opts.promptFn ?? prompts;
    this.suppliedAuthority = opts.authority ?? null;
  }

  public request(request: ConfirmationRequest): Promise<ConfirmationDecision> {
    this.sink.write(renderConsentCard(request));
    const authority = this.authorityFor(request);
    if (authority === null) return this.promptDirectly(request);

    const gateway = new AuthorityConnectorConfirmationGateway({
      authority,
      limits: { agentConfirmTimeoutMs: request.timeout_ms },
      answer: async (_request, _signal) => {
        const response = (await this.promptFn({
          type: 'confirm',
          name: 'granted',
          message: 'Allow this action?',
          initial: false,
        })) as { granted?: boolean } | undefined;
        return response?.granted === true ? 'granted' : 'denied';
      },
    });
    return gateway.request(request) as Promise<ConfirmationDecision>;
  }

  private async promptDirectly(request: ConfirmationRequest): Promise<ConfirmationDecision> {
    const response = (await this.promptFn({
      type: 'confirm',
      name: 'granted',
      message: 'Allow this action?',
      initial: false,
    })) as { granted?: boolean } | undefined;
    const granted = response?.granted === true;

    return {
      confirmation_id: request.confirmation_id,
      decision: granted ? 'granted' : 'denied',
      decided_at: new Date().toISOString(),
      decided_by: 'user_interactive',
    };
  }

  private authorityFor(request: ConfirmationRequest): InterventionAuthorityType | null {
    if (this.suppliedAuthority !== null) return this.suppliedAuthority;
    const existing = this.authorities.get(request.run_id);
    if (existing !== undefined) return existing;
    const ceiling = new UnattendedCeilingClock({ now: Date.now });
    ceiling.setAttendance(1);
    const authority = new InterventionAuthority({
      runId: request.run_id,
      log: new InterventionLog(join(runsRoot(), request.run_id, 'interventions.jsonl')),
      events: { publish: () => undefined, flush: () => Promise.resolve() },
      clock: { now: () => new Date().toISOString() },
      ceiling,
    });
    this.authorities.set(request.run_id, authority);
    return authority;
  }
}

function renderConsentCard(request: ConfirmationRequest): string {
  const cost = request.expected_cost
    ? `${request.expected_cost.amount} ${request.expected_cost.currency}`
    : 'unknown';
  return [
    '',
    '┌─ Confirmation required ─────────────────────────────',
    `│ Action:      ${request.action_kind} on ${request.host}`,
    `│ Description: ${request.description}`,
    `│ Cost:        ${cost}`,
    `│ Consequence: ${request.consequence}`,
    '└──────────────────────────────────────────────────────',
    '',
  ].join('\n');
}
