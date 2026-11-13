/**
 * `readRunResult` (FEAT-066 TASK-004): everything the app's Run result page
 * needs from one run directory, read so that one bad file fails only its own
 * slot.
 *
 * 1. Validate the run id; a missing run directory is {@link RunNotFoundError}.
 * 2. Reconcile first when FEAT-064 is wired (the injected hook), as
 *    `yantra list` does.
 * 3. Normalize either manifest shape (the ask/research/do pipeline, or the
 *    workflow `RunManifest`). A corrupt manifest still yields a view: mode
 *    `unknown`, the run id as the title, every other slot still read.
 * 4. Document: `brief.json`, else `document.json`, else none. A different
 *    `schema_version` is `unsupported`; any other failure is `corrupt`.
 * 5. `outputs.json` for workflow runs (256 KiB cap); 6. `run-health.json`;
 *    7. `report.md` size; 8. the public inventory; 9. the terminal reason;
 *    10. the live flag, never "running" for an owner that cannot be verified.
 *
 * Finally a size guard keeps the serialized view at or under
 * `RUN_RESULT_MAX_BYTES`, degrading the document, then the outputs, to
 * `too_large`. Nothing is ever cut mid-JSON.
 */

import { stat as fsStat } from 'node:fs/promises';
import { join } from 'node:path';

import {
  BRIEF_SCHEMA_VERSION,
  Brief,
  ExecutionState,
  RUN_ARTIFACT_REGISTRY,
  RUN_RESULT_MAX_BYTES,
  RunHealth,
  SLOT_DETAIL_MAX,
  TaskOutcome,
  TemplatedReport,
  TerminationReason,
  isRunId,
  type ArtifactSlot,
  type LedgerMode,
  type RunResultView,
} from '@yantra/protocol';
import { z } from 'zod';

import { NodeProcessLivenessProbe } from '../browser/process-identity.js';
import { ownerVerdict, readLease } from '../run-ownership/lease-store.js';

import { NODE_BOUNDED_READ_FS, readCapped, type BoundedReadFs } from './bounded-read.js';
import { ArtifactAccessError, RunNotFoundError } from './errors.js';
import { listRunArtifacts, type InventoryFs } from './inventory.js';
import { readTerminalReason } from './terminal-reason.js';

/** The largest `outputs.json` a view embeds. */
export const OUTPUTS_CAP_BYTES = 256 * 1024;

function capOf(entryId: string): number {
  return RUN_ARTIFACT_REGISTRY.find((entry) => entry.id === entryId)?.inline_cap_bytes ?? 0;
}

/** What the live flag says about a run that has not ended. */
export type LiveState = 'running' | 'waiting_for_you' | 'unknown_owner';

export interface RunResultDeps {
  /** The runs directory, from `runsRoot()`. */
  readonly runsDir: string;
  /** FEAT-064 reconcile-if-dead for one run, run first; failures never fail the read. */
  readonly reconcile?: (runDir: string) => Promise<void>;
  /**
   * The live flag. Defaults to the FEAT-064 lease probe: a lease whose owner
   * is alive is `running`; a running manifest whose owner cannot be verified
   * is `unknown_owner`, never dead.
   */
  readonly live?: (runDir: string, manifestStatus: string) => Promise<LiveState | null>;
  readonly readFs?: BoundedReadFs;
  readonly inventoryFs?: InventoryFs;
}

/** The manifest, normalized across both shapes. */
export interface NormalizedManifest {
  readonly mode: LedgerMode | 'unknown';
  /** The query or goal the run was started with, when the manifest records one. */
  readonly intent: string | null;
  readonly workflowName: string | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly durationMs: number | null;
  readonly status: string;
  readonly taskOutcome: TaskOutcome | null;
  readonly terminationReason: TerminationReason | null;
  readonly executionState: ExecutionState | null;
  readonly failureClass: string | null;
  readonly agentError: { readonly code: string; readonly message: string } | null;
}

const PIPELINE_MODES: ReadonlySet<string> = new Set(['ask', 'research', 'do']);

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function nonNegativeInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : null;
}

function durationBetween(start: string | null, end: string | null): number | null {
  if (start === null || end === null) return null;
  const ms = Date.parse(end) - Date.parse(start);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

function enumOf<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> | null {
  const parsed = schema.safeParse(value);
  return parsed.success ? (parsed.data as z.infer<T>) : null;
}

/** Normalizes a parsed manifest object, or null when it is neither known shape. */
export function normalizeManifest(
  raw: Readonly<Record<string, unknown>>,
): NormalizedManifest | null {
  // The ask/research/do pipeline shape: `type` + `query`.
  const type = str(raw.type);
  if (type !== null && PIPELINE_MODES.has(type)) {
    const startedAt = str(raw.started_at);
    const endedAt = str(raw.finished_at);
    return {
      mode: type as LedgerMode,
      intent: str(raw.query),
      workflowName: null,
      startedAt,
      endedAt,
      durationMs: durationBetween(startedAt, endedAt),
      status: str(raw.status) ?? 'unknown',
      taskOutcome: enumOf(TaskOutcome, raw.task_outcome ?? raw.taskOutcome),
      terminationReason: enumOf(TerminationReason, raw.termination_reason),
      executionState: enumOf(ExecutionState, raw.executionState),
      failureClass: str(raw.failure_class),
      agentError: null,
    };
  }
  // The workflow `RunManifest` shape (also agentic runs, `runKind: agentic`).
  const workflowName = str(raw.workflowName);
  if (workflowName === null) return null;
  const startedAt = str(raw.startedAt);
  const endedAt = str(raw.endedAt);
  const agentError =
    raw.agentError !== null && typeof raw.agentError === 'object'
      ? (raw.agentError as Record<string, unknown>)
      : null;
  const code = str(agentError?.code);
  const message = str(agentError?.message);
  return {
    mode:
      raw.runKind === 'agentic' && PIPELINE_MODES.has(workflowName)
        ? (workflowName as LedgerMode)
        : 'run',
    intent: null,
    workflowName,
    startedAt,
    endedAt,
    durationMs: nonNegativeInt(raw.durationMs) ?? durationBetween(startedAt, endedAt),
    status: str(raw.status) ?? 'unknown',
    taskOutcome: enumOf(TaskOutcome, raw.taskOutcome),
    terminationReason: enumOf(TerminationReason, raw.terminationReason),
    executionState: enumOf(ExecutionState, raw.executionState),
    failureClass: str(raw.failureClass),
    agentError: code === null ? null : { code, message: message ?? '' },
  };
}

/** A bounded, content-free summary of why a document failed validation. */
function issueSummary(error: z.ZodError): string {
  const issue = error.issues[0];
  const where = issue === undefined || issue.path.length === 0 ? '(root)' : issue.path.join('.');
  const text = `${String(error.issues.length)} issue(s); first at ${where}: ${issue?.code ?? 'invalid'}`;
  return text.slice(0, SLOT_DETAIL_MAX);
}

/** Reads one JSON artifact into a slot, applying a schema and a version check. */
async function readJsonSlot<T>(
  runDir: string,
  path: string,
  cap: number,
  parse: (value: unknown) => z.SafeParseReturnType<unknown, T>,
  expectedVersion: unknown,
  fs: BoundedReadFs,
): Promise<ArtifactSlot<T>> {
  const read = await readCapped(join(runDir, path), cap, fs);
  if (read.state === 'missing') return { state: 'missing', path };
  if (read.state === 'too_large') {
    return { state: 'too_large', path, bytes: read.bytes, cap: read.cap };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(read.text);
  } catch {
    return { state: 'corrupt', path, detail: 'not valid JSON' };
  }
  if (expectedVersion !== undefined && raw !== null && typeof raw === 'object') {
    const found = (raw as Record<string, unknown>).schema_version;
    if (found !== undefined && found !== expectedVersion) {
      const version =
        typeof found === 'string' || typeof found === 'number' || typeof found === 'boolean'
          ? String(found)
          : JSON.stringify(found);
      return { state: 'unsupported', path, found_version: version.slice(0, 64) };
    }
  }
  const parsed = parse(raw);
  return parsed.success
    ? { state: 'ok', value: parsed.data, path }
    : { state: 'corrupt', path, detail: issueSummary(parsed.error) };
}

async function readDocument(runDir: string, fs: BoundedReadFs): Promise<RunResultView['document']> {
  const brief = await readJsonSlot(
    runDir,
    'brief.json',
    capOf('brief.json'),
    (value) => Brief.safeParse(value),
    BRIEF_SCHEMA_VERSION,
    fs,
  );
  if (brief.state !== 'missing') return { kind: 'brief', slot: brief };
  const document = await readJsonSlot(
    runDir,
    'document.json',
    capOf('document.json'),
    (value) => TemplatedReport.safeParse(value),
    BRIEF_SCHEMA_VERSION,
    fs,
  );
  if (document.state !== 'missing') return { kind: 'templated_report', slot: document };
  return { kind: 'none' };
}

const OutputsRecord = z.record(z.unknown());

async function readOutputs(
  runDir: string,
  fs: BoundedReadFs,
): Promise<ArtifactSlot<Record<string, unknown>>> {
  return readJsonSlot(
    runDir,
    'outputs.json',
    OUTPUTS_CAP_BYTES,
    (value) => OutputsRecord.safeParse(value),
    undefined,
    fs,
  );
}

/** The FEAT-064 lease probe; see {@link RunResultDeps.live}. */
export async function leaseLiveState(
  runDir: string,
  manifestStatus: string,
): Promise<LiveState | null> {
  let lease: Awaited<ReturnType<typeof readLease>>;
  try {
    lease = await readLease(runDir);
  } catch {
    return 'unknown_owner';
  }
  if (lease.kind === 'absent') {
    return manifestStatus === 'running' || manifestStatus === 'queued' ? 'unknown_owner' : null;
  }
  if (lease.kind === 'corrupt') return 'unknown_owner';
  const verdict = await ownerVerdict(lease.lease, new NodeProcessLivenessProbe()).catch(
    () => 'unknown' as const,
  );
  // A dead owner the reconciler has not ended yet is still not shown as running.
  return verdict === 'alive' ? 'running' : 'unknown_owner';
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/** Keeps the view within {@link RUN_RESULT_MAX_BYTES}; see the module comment. */
export function enforceViewSize(view: RunResultView): RunResultView {
  let current = view;
  if (jsonBytes(current) <= RUN_RESULT_MAX_BYTES) return current;
  if (current.document.kind !== 'none' && current.document.slot.state === 'ok') {
    const bytes = jsonBytes(current.document.slot.value);
    const slot = {
      state: 'too_large' as const,
      path: current.document.slot.path,
      bytes,
      cap: RUN_RESULT_MAX_BYTES,
    };
    current = {
      ...current,
      document:
        current.document.kind === 'brief'
          ? { kind: 'brief', slot }
          : { kind: 'templated_report', slot },
    };
  }
  if (jsonBytes(current) <= RUN_RESULT_MAX_BYTES) return current;
  if (current.outputs?.state === 'ok') {
    current = {
      ...current,
      outputs: {
        state: 'too_large',
        path: current.outputs.path,
        bytes: jsonBytes(current.outputs.value),
        cap: RUN_RESULT_MAX_BYTES,
      },
    };
  }
  if (jsonBytes(current) <= RUN_RESULT_MAX_BYTES) return current;
  // Last resort: the inventory is the only other unbounded-length part.
  return { ...current, artifacts: current.artifacts.slice(0, 200), artifacts_truncated: true };
}

/**
 * Reads one run for the Run result page; see the module comment.
 *
 * @throws {ArtifactAccessError} `invalid_run_id` before any filesystem call.
 * @throws {RunNotFoundError} when the run directory does not exist.
 */
export async function readRunResult(runId: string, deps: RunResultDeps): Promise<RunResultView> {
  if (!isRunId(runId)) throw new ArtifactAccessError('invalid_run_id');
  const runDir = join(deps.runsDir, runId);
  const isDir = await fsStat(runDir).then(
    (info) => info.isDirectory(),
    () => false,
  );
  if (!isDir) throw new RunNotFoundError(runId);
  if (deps.reconcile !== undefined) await deps.reconcile(runDir).catch(() => undefined);
  const fs = deps.readFs ?? NODE_BOUNDED_READ_FS;

  const manifestRead = await readCapped(join(runDir, 'manifest.json'), capOf('manifest.json'), fs);
  let manifest: NormalizedManifest | null = null;
  if (manifestRead.state === 'ok') {
    try {
      const raw = JSON.parse(manifestRead.text) as unknown;
      if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
        manifest = normalizeManifest(raw as Record<string, unknown>);
      }
    } catch {
      manifest = null;
    }
  }

  const [document, health, reportInfo, inventory, terminal] = await Promise.all([
    readDocument(runDir, fs),
    readJsonSlot(
      runDir,
      'run-health.json',
      capOf('run-health.json'),
      (value) => RunHealth.safeParse(value),
      1,
      fs,
    ),
    fs.stat(join(runDir, 'report.md')).then(
      (info) =>
        info.isFile() ? { exists: true, bytes: info.size } : { exists: false, bytes: null },
      () => ({ exists: false, bytes: null }),
    ),
    listRunArtifacts(runDir, deps.inventoryFs === undefined ? {} : { fs: deps.inventoryFs }),
    readTerminalReason(runDir, manifest, fs),
  ]);
  const outputs = manifest?.mode === 'run' ? await readOutputs(runDir, fs) : null;
  const status = manifest?.status ?? 'unknown';
  const live = await (deps.live ?? leaseLiveState)(runDir, status).catch(
    () => 'unknown_owner' as const,
  );

  const documentTitle =
    document.kind !== 'none' && document.slot.state === 'ok' ? document.slot.value.title : null;
  const noticesSource: RunResultView['notices_source'] =
    document.kind === 'brief' && document.slot.state === 'ok'
      ? 'brief'
      : document.kind === 'templated_report' && document.slot.state === 'ok'
        ? 'document'
        : health.state === 'ok'
          ? 'run_health'
          : 'none';

  const view: RunResultView = {
    run_id: runId,
    mode: manifest?.mode ?? 'unknown',
    title: documentTitle ?? manifest?.intent ?? manifest?.workflowName ?? runId,
    started_at: manifest?.startedAt ?? null,
    ended_at: manifest?.endedAt ?? null,
    duration_ms: manifest?.durationMs ?? null,
    status,
    task_outcome: manifest?.taskOutcome ?? null,
    termination_reason: manifest?.terminationReason ?? null,
    execution_state: manifest?.executionState ?? null,
    live: live === null ? null : { state: live },
    document,
    outputs,
    terminal,
    run_health: health,
    report: reportInfo,
    artifacts: [...inventory.items],
    artifacts_truncated: inventory.truncated,
    notices_source: noticesSource,
  };
  return enforceViewSize(view);
}
