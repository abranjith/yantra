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

import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';

import {
  outcomeFirstLine,
  taskOutcomeOf,
  type AgentProgressEvent,
  type AgentTaskConnector,
  type AgenticTaskOutcome,
} from '@yantra/agent';
import type { Brief, ConfirmationRequest, TaskEvent, TemplatedReport } from '@yantra/protocol';
import { SCHEMA_VERSION } from '@yantra/protocol';

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
          `[${event.tool}] ${event.status} — ${event.summary}` +
            `${event.durationMs === null ? '' : ` (${event.durationMs}ms)`}\n`,
        );
        return;
      case 'contract_declared':
        // What the run understood, beside the goal echo on stderr, so a
        // misreading is visible in the first seconds. Control characters are
        // stripped again here: the terminal is the last boundary.
        opts.errStream.write(
          `${event.revision === 1 ? 'understood' : 'understood (revised)'}: ` +
            `${stripControlCharacters(event.summary)}\n`,
        );
        return;
      case 'progress':
      case 'recovery':
        opts.errStream.write(`${event.type}: ${stripControlCharacters(event.summary)}\n`);
        return;
      case 'capability_gap':
        // FEAT-058: a declared item the run cannot deliver, disclosed right
        // after the echo above, in ASCII punctuation; the run keeps going.
        opts.errStream.write(`${stripControlCharacters(event.summary)}\n`);
        return;
    }
  }

  /** Render a safe advisory on stderr, suppressing it for machine-readable output. */
  public emitAgentWarning(warning: string): void {
    const opts = this.requireAgentOptions();
    if (opts.json) return;
    opts.errStream.write(`warning: ${warning}\n`);
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
      opts.stream.write(`${JSON.stringify(record)}\n`);
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
