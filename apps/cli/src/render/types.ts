/**
 * Renderer abstractions shared by the terminal and JSON output modes.
 *
 * Renderers are passed to each command via `CommandDeps`; the command picks
 * the right method for its payload kind (e.g. {@link OutputRenderer.renderRun})
 * and the renderer drops bytes into the provided WritableStream.
 *
 * The two renderer implementations ({@link TerminalRenderer},
 * {@link JSONRenderer}) live in adjacent modules.
 */

import type { Brief, TaskEvent } from '@yantra/protocol';

import type { GlobalFlags } from '../global-flags.js';

/**
 * Terminal progressive-disclosure level. Declared here (not in
 * `brief-terminal.ts`) so the dependency-free `json.ts` path can reference it
 * without transitively importing the rendering toolchain — the `--json`
 * import-restriction guard depends on this separation.
 */
export type BriefDetailLevel = 'overview' | 'standard' | 'full';

/** What a Brief render writes to stdout. */
export type BriefOutputFormat = 'terminal' | 'md' | 'html' | 'json';

/** On-disk paths of the persisted Brief artifacts. */
export interface BriefArtifactPaths {
  readonly jsonPath: string;
  readonly mdPath: string;
  readonly htmlPath: string;
}

export interface ConnectorRenderOpts {
  readonly json: boolean;
  readonly debug: boolean;
  readonly noColor: boolean;
  readonly stream: NodeJS.WritableStream;
  readonly errStream: NodeJS.WritableStream;
  /** Brief disclosure level (terminal format only); defaults to `standard`. */
  readonly briefDetail?: BriefDetailLevel;
  /** Which Brief representation goes to stdout; defaults to `terminal`. */
  readonly briefFormat?: BriefOutputFormat;
  /** Target terminal width for the Brief renderer; clamped to [60, 120]. */
  readonly width?: number;
}

export function renderOptsFromGlobals(flags: GlobalFlags): ConnectorRenderOpts {
  return {
    json: flags.json,
    debug: flags.debug,
    noColor: flags.noColor,
    stream: process.stdout,
    errStream: process.stderr,
  };
}

/** A row in `yantra list` output. */
export type ListItem =
  | {
      readonly kind: 'workflow';
      readonly name: string;
      readonly stepCount: number;
      readonly securityClass: string;
      readonly modifiedAt: string;
    }
  | {
      readonly kind: 'run';
      readonly runId: string;
      readonly workflowName: string;
      readonly status: string;
      readonly startedAt: string;
      readonly durationMs: number | null;
    };

/** A payload accepted by `OutputRenderer.renderShow`. */
export type ShowItem =
  | {
      readonly kind: 'workflow';
      readonly name: string;
      readonly yaml: string;
      readonly locatorCounts: Readonly<Record<string, number>>;
    }
  | {
      readonly kind: 'run';
      readonly runId: string;
      readonly manifest: Readonly<Record<string, unknown>>;
      readonly events: readonly Readonly<Record<string, unknown>>[];
    };

export interface DoctorRenderResult {
  readonly checks: readonly {
    readonly id: string;
    readonly title: string;
    readonly status: 'ok' | 'warn' | 'fail';
    readonly summary: string;
    readonly remediation?: string;
  }[];
  readonly overall: 'ok' | 'warn' | 'fail';
  readonly version: string;
  readonly platform: NodeJS.Platform;
  readonly nodeVersion: string;
}

export interface AuditRenderReport {
  readonly runId: string;
  readonly workflowName: string;
  readonly status: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly durationMs: number | null;
  readonly llmCallCount: number;
  readonly secretLookups: readonly {
    readonly key: string;
    readonly stepId: string;
    readonly ts: string;
  }[];
  readonly stepCount: number;
  readonly scopeMix: {
    readonly publicCount: number;
    readonly readOnlyDataCount: number;
    readonly authenticatedCount: number;
  };
  readonly trustNarrative: string;
  readonly agent: {
    readonly adapter: string;
    readonly sdkVersion: string;
    readonly provider: string;
    readonly model: string;
    readonly thinking: string;
    readonly authSource: string;
    readonly sessionId: string;
    readonly sessionFile: string;
    readonly promptVersion: string;
  } | null;
  readonly toolCalls: readonly {
    readonly seq: number;
    readonly callId: string;
    readonly tool: string;
    readonly status: 'ok' | 'error' | 'denied' | 'aborted' | 'incomplete';
    readonly durationMs: number | null;
    readonly confirmationId: string | null;
    readonly confirmationDecision: string | null;
    readonly incomplete: boolean;
  }[];
  readonly usage: {
    readonly turns: number;
    readonly inputTokens: number | null;
    readonly outputTokens: number | null;
    readonly costUsd: number | null;
  } | null;
  readonly terminalError: { readonly code: string; readonly message: string } | null;
}

export interface OutputRenderer {
  renderList(items: readonly ListItem[], opts: ConnectorRenderOpts): void;
  renderShow(item: ShowItem, opts: ConnectorRenderOpts): void;
  renderDoctor(result: DoctorRenderResult, opts: ConnectorRenderOpts): void;
  renderAudit(report: AuditRenderReport, opts: ConnectorRenderOpts): void;
  renderReport(markdown: string, opts: ConnectorRenderOpts): void;
  /**
   * Renders a synthesized Brief. Terminal styles it (per `briefDetail` /
   * `briefFormat`); JSON emits the Brief verbatim inside the schema envelope.
   * `artifacts` names the persisted `brief.md`/`brief.html`, or null when the
   * best-effort artifact write failed.
   */
  renderBrief(brief: Brief, artifacts: BriefArtifactPaths | null, opts: ConnectorRenderOpts): void;
  /** Streamed per-event rendering. Terminal: one-line tick. JSON: JSON Line. */
  renderEvent(event: TaskEvent, opts: ConnectorRenderOpts): void;
}
