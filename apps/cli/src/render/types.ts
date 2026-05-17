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

import type { TaskEvent } from '@yantra/protocol';

import type { GlobalFlags } from '../global-flags.js';

export interface ConnectorRenderOpts {
  readonly json: boolean;
  readonly debug: boolean;
  readonly noColor: boolean;
  readonly stream: NodeJS.WritableStream;
  readonly errStream: NodeJS.WritableStream;
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
}

export interface OutputRenderer {
  renderList(items: readonly ListItem[], opts: ConnectorRenderOpts): void;
  renderShow(item: ShowItem, opts: ConnectorRenderOpts): void;
  renderDoctor(result: DoctorRenderResult, opts: ConnectorRenderOpts): void;
  renderAudit(report: AuditRenderReport, opts: ConnectorRenderOpts): void;
  renderReport(markdown: string, opts: ConnectorRenderOpts): void;
  /** Streamed per-event rendering. Terminal: one-line tick. JSON: JSON Line. */
  renderEvent(event: TaskEvent, opts: ConnectorRenderOpts): void;
}
