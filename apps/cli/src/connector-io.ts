/**
 * `ConnectorIO` — the seam between an external IO surface (CLI today;
 * WhatsApp / email / web in Phase 2) and Yantra's inline executor.
 *
 * Responsibilities (the only three the interface owns):
 *
 *   1. Build a `TaskRequest` from the connector's native input shape.
 *   2. Subscribe to the run's `RunEvent` stream for the lifetime of one task
 *      (FEAT-063: one union for lifecycle, agent progress, consent waits,
 *      budgets, artifacts and the outcome).
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

import { join } from 'node:path';

import {
  outcomeFirstLine,
  taskOutcomeOf,
  type AgentProgressEvent,
  type AgentTaskConnector,
  type AgenticTaskOutcome,
} from '@yantra/agent';
import { RunEventStream } from '@yantra/core';
import type {
  Brief,
  ConfirmationRequest,
  RunEventDelivery,
  TemplatedReport,
} from '@yantra/protocol';
import { SCHEMA_VERSION, toRunEvent } from '@yantra/protocol';

import type { GlobalFlags } from './global-flags.js';
import { stripControlCharacters } from './render/goal-echo.js';
import type {
  AuditRenderReport,
  BriefArtifactPaths,
  ConnectorRenderOpts,
  DoctorRenderResult,
  DoctorSmokeRenderResult,
  ListItem,
  OutputRenderer,
  ShowItem,
} from './render/types.js';
import { subscribeRunEventRenderer, warningEvent } from './run-event-output.js';

export type ConnectorId = 'cli' | 'whatsapp' | 'email' | 'web';

export type ConnectorResult =
  | { readonly kind: 'list'; readonly items: readonly ListItem[] }
  | { readonly kind: 'show'; readonly item: ShowItem }
  | { readonly kind: 'doctor'; readonly result: DoctorRenderResult }
  | { readonly kind: 'doctor_smoke'; readonly result: DoctorSmokeRenderResult }
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
    }
  | {
      readonly kind: 'templated_report';
      readonly report: TemplatedReport;
      readonly artifacts: BriefArtifactPaths | null;
    };

export interface ConnectorIO extends AgentTaskConnector {
  readonly id: ConnectorId;

  /** The run's event stream; the command emits its own live lines through it. */
  readonly runEvents: RunEventStream;

  /**
   * Subscribes a handler to the run's event stream for the lifetime of one
   * task. The handler sees committed events only (each already appended to
   * `run-events.jsonl`, with its `seq`). The returned disposer is idempotent —
   * calling it twice is safe.
   */
  onEvent(handler: (delivery: RunEventDelivery) => void): () => void;

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
  readonly output?: { json(value: unknown): void; jsonLine(value: unknown): void };
  /**
   * The run's event stream, when the command created it first (to print its
   * goal echo and warnings before the run exists). Its renderer is already
   * subscribed, so the connector subscribes none of its own.
   */
  readonly runEvents?: RunEventStream;
}

export class CommandConnectorIO implements ConnectorIO {
  readonly id: ConnectorId = 'cli';
  /** The run's event stream: the command's own, or one this connector created and renders. */
  public readonly runEvents: RunEventStream;

  public constructor(
    private readonly renderer: OutputRenderer,
    private readonly agentOptions?: CliAgentConnectorOptions,
  ) {
    this.runEvents = agentOptions?.runEvents ?? new RunEventStream();
    // The connector's renderer is a projection of the union. A stream handed
    // in already has its renderer; one created here gets it now.
    if (agentOptions !== undefined && agentOptions.runEvents === undefined) {
      subscribeRunEventRenderer(this.runEvents, agentOptions.renderOpts, agentOptions.output);
    }
  }

  /** True only for an explicitly interactive, non-JSON TTY command. */
  public get interactive(): boolean {
    return this.agentOptions?.interactive === true;
  }

  onEvent(handler: (delivery: RunEventDelivery) => void): () => void {
    return this.runEvents.subscribe(handler);
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
      case 'doctor_smoke':
        this.renderer.renderDoctorSmoke(result.result, opts);
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
      case 'templated_report':
        this.renderer.renderTemplatedReport(result.report, result.artifacts, opts);
        return;
    }
  }

  /**
   * Emit one bounded agent progress item into the run's stream; the
   * subscribed renderer prints it. Raw tool inputs/outputs are absent by type.
   */
  public emitAgentEvent(event: AgentProgressEvent): void {
    this.requireAgentOptions();
    this.runEvents.emit(toRunEvent(event));
  }

  /** Emit a safe advisory; the terminal prints it on stderr and `--json` suppresses it. */
  public emitAgentWarning(warning: string): void {
    this.requireAgentOptions();
    this.runEvents.emit(warningEvent('agent', warning));
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

    return 'denied';
  }

  /** Render the finalized terminal state exactly once. */
  public renderAgentOutcome(outcome: AgenticTaskOutcome): void {
    const opts = this.requireAgentOptions();
    if (outcome.kind === 'published' && this.agentOptions?.suppressPublishedOutcome === true) {
      return;
    }
    if (opts.json) {
      const record = {
        schemaVersion: SCHEMA_VERSION,
        kind: 'agent_outcome',
        task_outcome: taskOutcomeOf(outcome),
        termination_reason: outcome.terminationReason,
        // FEAT-058: the saved captures as run-relative artifact references.
        artifacts: outcome.kind === 'published' ? outcome.artifacts : [],
        outcome,
      };
      if (this.agentOptions?.output) this.agentOptions.output.json(record);
      else opts.stream.write(`${JSON.stringify(record)}\n`);
      return;
    }
    switch (outcome.kind) {
      case 'published':
        // FEAT-054: the first line says whether the task was done, not only
        // that a Brief was saved.
        opts.stream.write(
          `\n${outcomeFirstLine(outcome)}\n` +
            screenshotLines(outcome.runDir, outcome.captureSets) +
            `Run: ${outcome.runId}\n`,
        );
        return;
      case 'handoff':
        opts.errStream.write(
          `\nHandoff: ${outcome.blocker}\nSafest next action: ${outcome.safestNextAction}\n`,
        );
        return;
      case 'failed':
      case 'budget_exhausted':
      case 'aborted':
        opts.errStream.write(`\n${agentFailureLine(outcome)}\n`);
        return;
    }
  }

  private requireAgentOptions(): ConnectorRenderOpts {
    if (!this.agentOptions) throw new Error('Agent connector requires render options');
    return this.agentOptions.renderOpts;
  }
}

/** Most `Screenshot:` lines printed before the rest are counted (FEAT-058 S10). */
const MAX_SCREENSHOT_LINES = 3;

/**
 * One `Screenshot: <absolute path>` line per saved capture set, under the
 * outcome's first line so that line stays bounded and greppable (S10): the
 * set's first file, `(part 1 of n)` for a tiled set, and `(incomplete:
 * <label>)` for a clipped or truncated one. At most three, then
 * `+N more in <run dir>/screenshots`.
 */
export function screenshotLines(
  runDir: string,
  sets: Extract<AgenticTaskOutcome, { readonly kind: 'published' }>['captureSets'],
): string {
  const shown = sets.slice(0, MAX_SCREENSHOT_LINES).map((set) => {
    const first = set.parts[0];
    if (first === undefined) return '';
    const absolute = join(runDir, ...first.path.split('/'));
    const tiled = set.parts.length > 1 ? ` (part 1 of ${set.parts.length})` : '';
    const missing = set.labels.filter((label) => label !== 'beyond_viewport');
    const incomplete = set.complete ? '' : ` (incomplete: ${missing.join(', ') || 'partial'})`;
    return `Screenshot: ${stripControlCharacters(absolute)}${tiled}${incomplete}\n`;
  });
  const more = sets.length - MAX_SCREENSHOT_LINES;
  const tail = more > 0 ? `+${more} more in ${join(runDir, 'screenshots')}\n` : '';
  return shown.join('') + tail;
}

/**
 * The one-line failure message `ask` and `research` raise for an outcome that
 * published nothing, led by its outcome word (FEAT-054 S9):
 * `Handoff: <blocker>: <next action>`, `Failed: <CODE>: <message>`, or
 * `Aborted: <CODE>: <message>`.
 */
export function agentFailureLine(
  outcome: Exclude<AgenticTaskOutcome, { readonly kind: 'published' }>,
): string {
  switch (outcome.kind) {
    case 'handoff':
      return `Handoff: ${outcome.blocker}: ${outcome.safestNextAction}`;
    case 'aborted':
      return `Aborted: ${outcome.error.code}: ${outcome.error.message}`;
    case 'failed':
    case 'budget_exhausted':
      return `Failed: ${outcome.error.code}: ${outcome.error.message}`;
  }
}

/** Helper for command handlers to derive render opts from global flags + streams. */
export function buildRenderOpts(
  flags: GlobalFlags,
  streams: {
    readonly stdout: NodeJS.WritableStream;
    readonly stderr: NodeJS.WritableStream;
  },
): ConnectorRenderOpts {
  return {
    json: flags.json,
    debug: flags.debug,
    noColor: flags.noColor,
    stream: streams.stdout,
    errStream: streams.stderr,
  };
}
