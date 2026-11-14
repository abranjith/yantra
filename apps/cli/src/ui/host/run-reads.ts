/**
 * The app's per-run reads (FEAT-066): `read.run_result` (the `open` command's
 * in-app adapter, plan §6), and beside it `read.report`, `read.audit` and
 * `read.artifact_window`.
 *
 * Each read resolves the run through core run-view functions in the host
 * process (plan D1) and maps typed core failures to RPC errors. Logs carry
 * run ids, slot states and error codes only, never file content (plan §11).
 */

import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import {
  ArtifactAccessError,
  RunNotFoundError,
  leaseLiveState,
  SparseLineIndex,
  readHead,
  readJsonlWindow,
  readRunResult,
  reconcileRun,
  resolvePublicArtifact,
  runsRoot,
  type LiveState,
  type PublicArtifact,
} from '@yantra/core';
import {
  AUDIT_WINDOW_ROWS,
  AuditPage,
  AuditParams,
  CLI_READ_SCHEMA_VERSION,
  JsonlWindow,
  JsonlWindowRequest,
  REPORT_READ_CAP_BYTES,
  ReportResult,
  RunResultParams,
  RunResultView,
} from '@yantra/protocol';

import {
  buildAuditReport,
  createAuditCache,
  type AuditCache,
} from '../../commands/audit-builder.js';

import { SILENT_HOST_LOGGER, type HostLogger } from './host.js';
import { RpcError, type RpcMethodRegistry } from './rpc-server.js';

/** What the per-run reads need from the host. */
export interface RunReadDeps {
  /** Defaults to `runsRoot()`. */
  readonly runsDir?: string;
  readonly logger?: HostLogger;
  /** FEAT-064 reconcile-if-dead for one run; defaults to `reconcileRun`. */
  readonly reconcile?: (runDir: string) => Promise<void>;
  /** The live flag; defaults to the FEAT-064 lease probe. */
  readonly live?: (runDir: string, manifestStatus: string) => Promise<LiveState | null>;
}

/** The RPC error for a typed core failure, or the error unchanged. */
export function runReadError(error: unknown, runId: string): unknown {
  if (error instanceof RunNotFoundError) {
    return new RpcError(
      'not_found',
      `Run ${runId} was not found.`,
      'Pick a run from the Ledger, or run `yantra list`.',
    );
  }
  if (error instanceof ArtifactAccessError) {
    switch (error.code) {
      case 'invalid_run_id':
        return new RpcError('invalid_params', 'The run ID is malformed.');
      case 'not_found':
        return new RpcError('not_found', 'That file does not exist in this run.');
      case 'too_large':
        return new RpcError('too_large', 'That file is too large to open here.');
      case 'not_public':
      case 'outside_run':
        return new RpcError(
          'not_allowed',
          'That file is not an artifact the app can open.',
          'Open the run directory from the terminal instead.',
        );
    }
  }
  return error;
}

/** Remembers which corrupt (run, file) pairs were already logged this host lifetime. */
export class CorruptSlotLog {
  private readonly seen = new Set<string>();

  public constructor(private readonly logger: HostLogger) {}

  /** Logs once per (run, file) at warn: run id, entry and state only. */
  public note(runId: string, path: string, state: string): void {
    const key = `${runId}\u0000${path}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.logger.warn({ runId, entry_id: path, state }, 'run artifact unreadable');
  }
}

function slotStates(view: RunResultView): Record<string, string> {
  return {
    document: view.document.kind === 'none' ? 'none' : view.document.slot.state,
    outputs: view.outputs?.state ?? 'none',
    run_health: view.run_health.state,
  };
}

/** `read.run_result {run_id}`. */
export async function readRunResultForApp(
  runId: string,
  deps: RunReadDeps,
  corrupt: CorruptSlotLog,
): Promise<RunResultView> {
  const logger = deps.logger ?? SILENT_HOST_LOGGER;
  const started = Date.now();
  let view: RunResultView;
  try {
    view = await readRunResult(runId, {
      runsDir: deps.runsDir ?? runsRoot(),
      reconcile:
        deps.reconcile ??
        (async (runDir: string) => {
          await reconcileRun(runDir, { trigger: 'host' });
        }),
      live: deps.live ?? leaseLiveState,
    });
  } catch (error) {
    throw runReadError(error, runId);
  }
  const states = slotStates(view);
  logger.debug?.(
    { runId, read: 'run_result', slots: states, durationMs: Date.now() - started },
    'run read',
  );
  if (view.document.kind !== 'none' && view.document.slot.state === 'corrupt') {
    corrupt.note(runId, view.document.slot.path, 'corrupt');
  }
  if (view.outputs?.state === 'corrupt') corrupt.note(runId, view.outputs.path, 'corrupt');
  if (view.run_health.state === 'corrupt') corrupt.note(runId, view.run_health.path, 'corrupt');
  return view;
}

/** The CLI's own words for a run without a report (`yantra report`). */
export function reportMissingError(runId: string): RpcError {
  return new RpcError(
    'not_found',
    `report.md not found for run ${runId} (the run may still be in progress).`,
  );
}

/**
 * `read.report {run_id}`: `yantra report --json`, read through the public
 * artifact gate. Over {@link REPORT_READ_CAP_BYTES} it returns the head of the
 * file cut at a line boundary, with `truncated` and the full `bytes`.
 */
export async function readReportForApp(runId: string, deps: RunReadDeps): Promise<ReportResult> {
  let artifact: PublicArtifact;
  try {
    artifact = await resolvePublicArtifact(deps.runsDir ?? runsRoot(), runId, 'report.md', {
      exposures: ['view'],
    });
  } catch (error) {
    if (error instanceof ArtifactAccessError && error.code === 'not_found') {
      throw reportMissingError(runId);
    }
    throw runReadError(error, runId);
  }
  const head = await readHead(artifact.absPath, REPORT_READ_CAP_BYTES);
  if (head === null) throw reportMissingError(runId);
  const base = {
    schemaVersion: CLI_READ_SCHEMA_VERSION,
    kind: 'report' as const,
    markdown: head.text,
  };
  return head.truncated ? { ...base, truncated: true, bytes: head.bytes } : base;
}

/**
 * `read.artifact_window {run_id, path, from_line, limit}`: one window of a
 * public JSONL artifact, through the gate, for `jsonl` viewers only.
 */
export async function readArtifactWindowForApp(
  request: JsonlWindowRequest,
  deps: RunReadDeps,
  index: SparseLineIndex,
): Promise<JsonlWindow> {
  let artifact: PublicArtifact;
  try {
    artifact = await resolvePublicArtifact(
      deps.runsDir ?? runsRoot(),
      request.run_id,
      request.path,
      {
        exposures: ['view'],
      },
    );
  } catch (error) {
    throw runReadError(error, request.run_id);
  }
  if (artifact.entry.viewer !== 'jsonl') {
    throw new RpcError(
      'not_allowed',
      `${artifact.relPath} is not a JSONL artifact.`,
      'Open it through its own viewer.',
    );
  }
  const window = await readJsonlWindow(artifact.absPath, request.from_line, request.limit, index);
  return { path: artifact.relPath, ...window };
}

/** Encodes a row offset as an opaque audit cursor. */
export function encodeAuditCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ v: 1, o: offset }), 'utf8').toString('base64url');
}

/** Decodes an audit cursor, or throws `invalid_params`; it never falls back to the start. */
export function decodeAuditCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (value !== null && typeof value === 'object') {
      const { v, o } = value as { v?: unknown; o?: unknown };
      if (v === 1 && typeof o === 'number' && Number.isInteger(o) && o >= 0) return o;
    }
  } catch {
    // Falls through to the refusal.
  }
  throw new RpcError(
    'invalid_params',
    'The cursor is not one this host issued.',
    'Start again without a cursor.',
  );
}

function nextCursor(offset: number, total: number): string | null {
  return offset + AUDIT_WINDOW_ROWS < total ? encodeAuditCursor(offset + AUDIT_WINDOW_ROWS) : null;
}

/**
 * `read.audit {run_id, tool_calls_cursor?, captures_cursor?}`: the same audit
 * `yantra audit` tells, from the same builder, with windows of
 * {@link AUDIT_WINDOW_ROWS} tool calls and captures, so a run of any size
 * stays within the message limit.
 */
export async function readAuditForApp(
  params: AuditParams,
  deps: RunReadDeps,
  cache: AuditCache,
): Promise<AuditPage> {
  const toolOffset = decodeAuditCursor(params.tool_calls_cursor);
  const captureOffset = decodeAuditCursor(params.captures_cursor);
  const runDir = runDirOf(deps, params.run_id);
  const isDir = await stat(runDir).then(
    (info) => info.isDirectory(),
    () => false,
  );
  if (!isDir) throw runReadError(new RunNotFoundError(params.run_id), params.run_id);
  const result = await buildAuditReport(params.run_id, runDir, {
    cache,
    window: {
      toolCalls: { offset: toolOffset, limit: AUDIT_WINDOW_ROWS },
      captures: { offset: captureOffset, limit: AUDIT_WINDOW_ROWS },
    },
  });
  if (result.kind === 'err') {
    throw result.error.kind === 'missing'
      ? new RpcError('not_found', `Run ${params.run_id} has no manifest.json to audit.`)
      : new RpcError('internal_error', `The audit of run ${params.run_id} could not be built.`);
  }
  return {
    report: result.report,
    tool_calls: {
      total: result.totals.toolCalls,
      next_cursor: nextCursor(toolOffset, result.totals.toolCalls),
    },
    captures: {
      total: result.totals.captures,
      next_cursor: nextCursor(captureOffset, result.totals.captures),
    },
  };
}

/** Registers the per-run reads. */
export function registerRunReads(methods: RpcMethodRegistry, deps: RunReadDeps = {}): void {
  const corrupt = new CorruptSlotLog(deps.logger ?? SILENT_HOST_LOGGER);
  methods.register('read.run_result', {
    params: RunResultParams,
    result: RunResultView,
    handler: ({ run_id: runId }) => readRunResultForApp(runId, deps, corrupt),
  });
  const logger = deps.logger ?? SILENT_HOST_LOGGER;
  const index = new SparseLineIndex(undefined, (event) => {
    logger.debug?.({ read: 'artifact_window', ...event }, 'jsonl index built');
  });
  methods.register('read.artifact_window', {
    params: JsonlWindowRequest,
    result: JsonlWindow,
    handler: (request) => readArtifactWindowForApp(request, deps, index),
  });
  const audits = createAuditCache();
  methods.register('read.audit', {
    params: AuditParams,
    result: AuditPage,
    handler: (params) => readAuditForApp(params, deps, audits),
  });
  methods.register('read.report', {
    params: RunResultParams,
    result: ReportResult,
    handler: ({ run_id: runId }) => readReportForApp(runId, deps),
  });
}

/** The run directory for a validated run id. */
export function runDirOf(deps: RunReadDeps, runId: string): string {
  return join(deps.runsDir ?? runsRoot(), runId);
}
