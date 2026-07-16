/**
 * `ConnectorIO` — the seam between an external IO surface (CLI today;
 * WhatsApp / email / web in Phase 2) and Yantra's inline executor.
 *
 * Responsibilities (the only three the interface owns):
 *
 *   1. Build a `TaskRequest` from the connector's native input shape.
 *   2. Subscribe to the `TaskEvent` stream for the lifetime of one task.
 *   3. Render the final outcome and signal completion.
 *
 * Designed *now* so the Phase 2 split is a mechanical "add another
 * implementation" task, not a redesign. Resist the urge to grow the
 * interface — anything that doesn't fit these three responsibilities
 * belongs in surface-specific glue, not here.
 *
 * **Realized Phase-2 connector (FEAT-021):** the scheduler daemon is the first
 * non-CLI surface to drive the same inline executor. Rather than a full
 * `ConnectorIO`, an unattended fire reuses the executor's narrower
 * `ConfirmationGateway` seam via the `DaemonConfirmationGateway`
 * (park-and-notify) — "same protocol, two connectors" (plan §7). Result
 * rendering for a fire is to run-dir artifacts + `daemon.log`, not stdout.
 *
 * @see .spec-lite/features/feature_cli_polish_distribution.md §2.2.1
 * @see .spec-lite/features/feature_scheduling_runner.md
 */

import { createInterface } from 'node:readline/promises';

import type { AgentProgressEvent, AgentTaskConnector, AgenticTaskOutcome } from '@yantra/agent';
import type { Brief, ConfirmationRequest, TaskEvent } from '@yantra/protocol';
import { SCHEMA_VERSION } from '@yantra/protocol';

import type { GlobalFlags } from './global-flags.js';
import type {
  AuditRenderReport,
  BriefArtifactPaths,
  ConnectorRenderOpts,
  DoctorRenderResult,
  ListItem,
  OutputRenderer,
  ShowItem,
} from './render/types.js';

export type ConnectorId = 'cli' | 'whatsapp' | 'email' | 'web';

export type ConnectorResult =
  | { readonly kind: 'list'; readonly items: readonly ListItem[] }
  | { readonly kind: 'show'; readonly item: ShowItem }
  | { readonly kind: 'doctor'; readonly result: DoctorRenderResult }
  | { readonly kind: 'audit'; readonly report: AuditRenderReport }
  | { readonly kind: 'report'; readonly markdown: string }
  // FEAT-015: the unified Brief output. `ask` (and later `research`/`do`) fold
  // their result into this one kind; the renderer styles it three ways
  // (terminal/md/html) or emits it verbatim as `--json`. `artifacts` names the
  // persisted brief.md/brief.html, or null when the best-effort write failed.
  | {
      readonly kind: 'brief';
      readonly brief: Brief;
      readonly artifacts: BriefArtifactPaths | null;
    };

export interface ConnectorIO extends AgentTaskConnector {
  readonly id: ConnectorId;

  /**
   * Subscribes a handler to the task event stream for the lifetime of one
   * task. The returned disposer is idempotent — calling it twice is safe.
   */
  onEvent(handler: (event: TaskEvent) => void): () => void;

  /**
   * Renders the final outcome to the connector surface. For CLI this writes
   * to stdout (terminal or JSON); for Phase 2 connectors this returns a
   * typed reply object instead.
   */
  renderResult(result: ConnectorResult, opts: ConnectorRenderOpts): void;
}

/** Agent-stream configuration bound to a CLI connector for one command. */
export interface CliAgentConnectorOptions {
  readonly renderOpts: ConnectorRenderOpts;
  readonly interactive: boolean;
  readonly confirmationPrompt?: (
    request: ConfirmationRequest,
    signal: AbortSignal,
  ) => Promise<'granted' | 'denied'>;
  /** Command will render the published Brief itself using its selected format. */
  readonly suppressPublishedOutcome?: boolean;
}

/**
 * Trivial in-process event bus the CLI uses when there isn't a wider one
 * available (e.g. for the audit/doctor commands which produce no
 * `TaskEvent`s). Phase 2 swaps in the FEAT-005 EventBus.
 */
class NoopEventStream {
  private readonly handlers = new Set<(event: TaskEvent) => void>();

  subscribe(handler: (event: TaskEvent) => void): () => void {
    this.handlers.add(handler);
    let disposed = false;
    return (): void => {
      if (disposed) return;
      disposed = true;
      this.handlers.delete(handler);
    };
  }
}

export class CLIConnectorIO implements ConnectorIO {
  readonly id: ConnectorId = 'cli';
  private readonly events = new NoopEventStream();

  public constructor(
    private readonly renderer: OutputRenderer,
    private readonly agentOptions?: CliAgentConnectorOptions,
  ) {}

  /** True only for an explicitly interactive, non-JSON TTY command. */
  public get interactive(): boolean {
    return this.agentOptions?.interactive === true && this.agentOptions.renderOpts.json === false;
  }

  onEvent(handler: (event: TaskEvent) => void): () => void {
    return this.events.subscribe(handler);
  }

  renderResult(result: ConnectorResult, opts: ConnectorRenderOpts): void {
    switch (result.kind) {
      case 'list':
        this.renderer.renderList(result.items, opts);
        return;
      case 'show':
        this.renderer.renderShow(result.item, opts);
        return;
      case 'doctor':
        this.renderer.renderDoctor(result.result, opts);
        return;
      case 'audit':
        this.renderer.renderAudit(result.report, opts);
        return;
      case 'report':
        this.renderer.renderReport(result.markdown, opts);
        return;
      case 'brief':
        this.renderer.renderBrief(result.brief, result.artifacts, opts);
        return;
    }
  }

  /** Render one bounded agent progress item; raw tool inputs/outputs are absent by type. */
  public emitAgentEvent(event: AgentProgressEvent): void {
    const opts = this.requireAgentOptions();
    if (opts.json) {
      opts.stream.write(
        `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, kind: 'agent_progress', event })}\n`,
      );
      return;
    }
    switch (event.type) {
      case 'assistant_text':
        opts.stream.write(event.text);
        return;
      case 'tool_started':
        opts.stream.write(`\n[${event.tool}] ${event.summary}\n`);
        return;
      case 'tool_finished':
        opts.stream.write(
          `[${event.tool}] ${event.status} â€” ${event.summary}` +
            `${event.durationMs === null ? '' : ` (${event.durationMs}ms)`}\n`,
        );
        return;
    }
  }

  /** Present a fail-closed terminal confirmation prompt. */
  public async requestConfirmation(
    request: ConfirmationRequest,
    signal: AbortSignal,
  ): Promise<'granted' | 'denied'> {
    if (!this.interactive) return 'denied';
    if (this.agentOptions?.confirmationPrompt) {
      return this.agentOptions.confirmationPrompt(request, signal);
    }

    const opts = this.requireAgentOptions();
    opts.errStream.write(
      `\nConfirmation required\n` +
        `  Action: ${request.action_kind}\n` +
        `  Host: ${request.host}\n` +
        `  Summary: ${request.description}\n` +
        `  Consequence: ${request.consequence}\n`,
    );
    const readline = createInterface({ input: process.stdin, output: opts.errStream });
    try {
      const answer = await readline.question('Allow this action? [y/N] ', { signal });
      return /^(y|yes)$/i.test(answer.trim()) ? 'granted' : 'denied';
    } finally {
      readline.close();
    }
  }

  /** Render the finalized terminal state exactly once. */
  public renderAgentOutcome(outcome: AgenticTaskOutcome): void {
    const opts = this.requireAgentOptions();
    if (opts.json) {
      opts.stream.write(
        `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, kind: 'agent_outcome', outcome })}\n`,
      );
      return;
    }
    switch (outcome.kind) {
      case 'published':
        if (this.agentOptions?.suppressPublishedOutcome === true) return;
        opts.stream.write(`\nPublished Brief: ${outcome.brief.htmlPath}\nRun: ${outcome.runId}\n`);
        return;
      case 'handoff':
        opts.errStream.write(
          `\nHuman handoff required: ${outcome.blocker}\nSafest next action: ${outcome.safestNextAction}\n`,
        );
        return;
      case 'failed':
      case 'budget_exhausted':
      case 'aborted':
        opts.errStream.write(`\n${outcome.error.code}: ${outcome.error.message}\n`);
        return;
    }
  }

  private requireAgentOptions(): ConnectorRenderOpts {
    return (
      this.agentOptions?.renderOpts ?? {
        json: false,
        debug: false,
        noColor: true,
        stream: process.stdout,
        errStream: process.stderr,
      }
    );
  }
}

/** Helper for command handlers to derive render opts from global flags + streams. */
export function buildRenderOpts(
  flags: GlobalFlags,
  streams: {
    readonly stdout?: NodeJS.WritableStream;
    readonly stderr?: NodeJS.WritableStream;
  } = {},
): ConnectorRenderOpts {
  return {
    json: flags.json,
    debug: flags.debug,
    noColor: flags.noColor,
    stream: streams.stdout ?? process.stdout,
    errStream: streams.stderr ?? process.stderr,
  };
}
