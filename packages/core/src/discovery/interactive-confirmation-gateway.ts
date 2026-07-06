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

import type { ConfirmationDecision, ConfirmationRequest } from '@yantra/protocol';
import prompts from 'prompts';

import type { ConfirmationGateway } from '../executor/confirmation-gateway.js';

/** Minimal stdout sink so tests can capture the rendered consent card. */
export interface ConsentRenderSink {
  write(text: string): void;
}

/** Options for {@link InteractiveConfirmationGateway}. */
export interface InteractiveConfirmationGatewayOptions {
  readonly sink?: ConsentRenderSink;
  /** Injected prompt function; defaults to the real `prompts` package. */
  readonly promptFn?: typeof prompts;
}

/**
 * Renders a consent card to the sink and blocks on a y/n terminal prompt.
 * A non-TTY / declined prompt (including Ctrl+C, which `prompts` resolves as
 * `undefined`) is treated as **denied** — fail-closed, never fail-open.
 */
export class InteractiveConfirmationGateway implements ConfirmationGateway {
  private readonly sink: ConsentRenderSink;
  private readonly promptFn: typeof prompts;

  public constructor(opts: InteractiveConfirmationGatewayOptions = {}) {
    this.sink = opts.sink ?? { write: (text: string) => process.stdout.write(text) };
    this.promptFn = opts.promptFn ?? prompts;
  }

  public async request(request: ConfirmationRequest): Promise<ConfirmationDecision> {
    this.sink.write(renderConsentCard(request));

    const response = (await this.promptFn({
      type: 'confirm',
      name: 'granted',
      message: 'Allow this action?',
      initial: false,
    })) as { granted?: boolean };

    const granted = response.granted === true;

    return {
      confirmation_id: request.confirmation_id,
      decision: granted ? 'granted' : 'denied',
      decided_at: new Date().toISOString(),
      decided_by: 'user_interactive',
    };
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
