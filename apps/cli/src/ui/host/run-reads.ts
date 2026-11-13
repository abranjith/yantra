/**
 * The app's per-run reads (FEAT-066): `read.run_result` (the `open` command's
 * in-app adapter, plan §6), and beside it `read.report`, `read.audit` and
 * `read.artifact_window`.
 *
 * Each read resolves the run through core run-view functions in the host
 * process (plan D1) and maps typed core failures to RPC errors. Logs carry
 * run ids, slot states and error codes only, never file content (plan §11).
 */

import { join } from 'node:path';

import {
  ArtifactAccessError,
  RunNotFoundError,
  leaseLiveState,
  readHead,
  readRunResult,
  reconcileRun,
  resolvePublicArtifact,
  runsRoot,
  type LiveState,
  type PublicArtifact,
} from '@yantra/core';
import {
  CLI_READ_SCHEMA_VERSION,
  REPORT_READ_CAP_BYTES,
  ReportResult,
  RunResultParams,
  RunResultView,
} from '@yantra/protocol';

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

/** Registers the per-run reads. */
export function registerRunReads(methods: RpcMethodRegistry, deps: RunReadDeps = {}): void {
  const corrupt = new CorruptSlotLog(deps.logger ?? SILENT_HOST_LOGGER);
  methods.register('read.run_result', {
    params: RunResultParams,
    result: RunResultView,
    handler: ({ run_id: runId }) => readRunResultForApp(runId, deps, corrupt),
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
