/**
 * The reconciler (FEAT-064, plan §8): exactly one terminal result for a run
 * whose owner died, and identity-verified reaping of the browsers it owned.
 *
 * Every step is idempotent, so a reconciler that crashes anywhere can simply
 * be run again: a terminal event it already appended is recognized (its
 * `termination_reason` is `owner_lost`) and never written twice.
 *
 * Uncertainty always resolves to doing nothing destructive: an owner or a
 * browser whose identity cannot be verified is never signalled, and the lease
 * that records it is kept.
 */

import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import {
  TASK_OUTCOME_TABLE,
  type FailureClass,
  type RunEventType,
  type TaskOutcome,
  type TerminationReason,
} from '@yantra/protocol';
import lockfile from 'proper-lockfile';

import type { ProcessIdentity, ProcessLivenessProbe } from '../browser/installation-types.js';
import {
  NodeProcessLivenessProbe,
  checkIdentities,
  processExists,
} from '../browser/process-identity.js';
import {
  NodeProcessTreeTerminator,
  type ProcessTreeTerminator,
} from '../browser/process-lifecycle.js';
import type { Logger } from '../browser/types.js';
import { writeFileAtomic } from '../fs/atomic-write.js';
import { readCommittedEvents } from '../run-channel/event-source.js';
import { RunEventLog, RunEventLogError } from '../run-events/log.js';

import { FileBrowserOwnershipRecorder } from './browser-ownership-recorder.js';
import {
  LEGACY_LOCK_FILENAME,
  RECONCILE_LOCK_FILENAME,
  RECONCILE_LOCK_STALE_MS,
  REAP_CONFIRM_MS,
} from './constants.js';
import { leaseOwner, readLease, readOwnedBrowsers, removeOwnershipFiles } from './lease-store.js';
import { resultEvidence } from './result-evidence.js';
import {
  appendReconciledRecord,
  type ReconcileEvidence,
  type ReconcileTrigger,
} from './runtime-record.js';

export type { ReconcileEvidence, ReconcileTrigger } from './runtime-record.js';

/** What one reconciliation found or did. */
export type ReconcileResult =
  | { readonly kind: 'no_lease' }
  | { readonly kind: 'owner_alive'; readonly pid: number }
  | { readonly kind: 'owner_unknown'; readonly pid: number | null }
  | { readonly kind: 'busy' }
  | {
      /**
       * `reconciled`: this or an earlier reconciler ended the run.
       * `completed_by_evidence`: the run had finished before its owner died.
       */
      readonly kind: 'reconciled' | 'completed_by_evidence';
      readonly outcome: TaskOutcome;
      readonly evidence: ReconcileEvidence;
      readonly reaped: number;
      readonly uncertain: number;
    };

/** Optional history index update; failures are logged, never fatal. */
export interface ReconcileHistory {
  recordFromRunDir(runId: string): Promise<unknown>;
}

export interface ReconcileDeps {
  readonly trigger: ReconcileTrigger;
  readonly probe?: ProcessLivenessProbe;
  readonly terminator?: ProcessTreeTerminator;
  readonly clock?: () => Date;
  readonly history?: ReconcileHistory | null;
  readonly logger?: Logger;
  /** Delay seam for the reap confirmation poll. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** `proper-lockfile` seam. */
  readonly lock?: typeof lockfile.lock;
  /** Test seam: called after each numbered step; a throw simulates a crash there. */
  readonly afterStep?: (step: number) => void | Promise<void>;
  /**
   * Holds `reconcile.lock` already (takeover); the reconciler then neither
   * takes nor releases it.
   */
  readonly lockHeld?: boolean;
}

const noopLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

/** Takes `reconcile.lock` for a run directory, or returns null when it is busy. */
export async function acquireReconcileLock(
  runDir: string,
  lock: typeof lockfile.lock = lockfile.lock,
): Promise<(() => Promise<void>) | null> {
  try {
    return await lock(runDir, {
      lockfilePath: join(runDir, RECONCILE_LOCK_FILENAME),
      stale: RECONCILE_LOCK_STALE_MS,
      retries: 0,
      realpath: false,
      onCompromised: () => undefined,
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ELOCKED') return null;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
}

/** The dead owner's epoch and identity, once ownership is known to be lost. */
interface LostOwnership {
  readonly epochSeq: number;
  readonly command: readonly string[] | null;
  readonly claimedAt: string | null;
  readonly legacyLock: boolean;
}

/**
 * Reconciles one run directory. See the module comment for the guarantees.
 */
export async function reconcileRun(runDir: string, deps: ReconcileDeps): Promise<ReconcileResult> {
  const release = deps.lockHeld === true ? null : await acquireReconcileLock(runDir, deps.lock);
  if (deps.lockHeld !== true && release === null) {
    const { existsSync } = await import('node:fs');
    return existsSync(runDir) ? { kind: 'busy' } : { kind: 'no_lease' };
  }
  try {
    return await reconcileLocked(runDir, deps);
  } finally {
    await release?.().catch(() => undefined);
  }
}

async function reconcileLocked(runDir: string, deps: ReconcileDeps): Promise<ReconcileResult> {
  const probe = deps.probe ?? new NodeProcessLivenessProbe();
  const logger = deps.logger ?? noopLogger;
  const clock = deps.clock ?? (() => new Date());
  const step = async (n: number): Promise<void> => {
    await deps.afterStep?.(n);
  };

  // 2. Re-verify under the lock.
  const lost = await verifyOwnerLost(runDir, probe);
  if ('kind' in lost) return lost;
  await step(2);

  // 3. The log: find this epoch's terminal event, or append exactly one.
  const runId = runDir.split(/[\\/]/u).at(-1) ?? '';
  const manifest = await readRawManifest(runDir);
  const scan = await scanEpoch(runDir, lost.epochSeq);
  let outcome: TaskOutcome;
  let evidence: ReconcileEvidence;
  let terminationReason: TerminationReason | null;
  let endedAt = scan.lastAt ?? clock().toISOString();
  if (scan.terminal !== null) {
    outcome = scan.terminal.task_outcome;
    terminationReason = scan.terminal.termination_reason;
    evidence = terminationReason === 'owner_lost' ? 'owner_lost' : 'event';
    endedAt = scan.terminal.at;
  } else if (manifest !== null && isTerminalManifest(manifest)) {
    outcome = manifest.taskOutcome as TaskOutcome;
    terminationReason = (manifest.terminationReason as TerminationReason | undefined) ?? null;
    evidence = 'manifest';
    endedAt = typeof manifest.endedAt === 'string' ? manifest.endedAt : endedAt;
    appendOutcome(runDir, runId, {
      outcome,
      terminationReason,
      failureClass: (manifest.failureClass as FailureClass | undefined) ?? null,
      at: endedAt,
    });
  } else {
    outcome = await resultEvidence(runDir, lost.epochSeq);
    terminationReason = 'owner_lost';
    evidence = 'owner_lost';
    appendOutcome(runDir, runId, {
      outcome,
      terminationReason,
      failureClass: 'unexpected',
      at: clock().toISOString(),
    });
  }
  await step(3);

  // 4. The manifest, preserving every field this code does not own.
  await patchManifest(runDir, runId, manifest, lost, {
    outcome,
    terminationReason,
    endedAt,
    interrupted: evidence === 'owner_lost',
  });
  await step(4);

  // 5. History; the index is rebuildable, so a failure is only logged.
  if (deps.history) {
    await deps.history.recordFromRunDir(runId).catch((error: unknown) => {
      logger.warn(
        { event: 'reconcile_history_failed', error_class: errorClass(error) },
        'reconcile_history_failed',
      );
    });
  }
  await step(5);

  // 6. Browsers, by identity only.
  const { reaped, uncertain } = await reapBrowsers(runDir, probe, deps, clock);
  await step(6);

  // 7. The lease goes only when no owned browser remains uncertain.
  if (uncertain === 0) {
    await removeOwnershipFiles(runDir);
    if (lost.legacyLock) await rm(join(runDir, LEGACY_LOCK_FILENAME), { force: true });
  }
  await step(7);

  // 8. One operator line.
  await appendReconciledRecord(runDir, {
    by: deps.trigger,
    evidence,
    reaped,
    uncertain,
    at: clock().toISOString(),
  }).catch(() => undefined);
  logger.info({ event: 'reconciled', by: deps.trigger, evidence, reaped, uncertain }, 'reconciled');
  return {
    kind: evidence === 'event' ? 'completed_by_evidence' : 'reconciled',
    outcome,
    evidence,
    reaped,
    uncertain,
  };
}

/**
 * Decides, under the lock, whether the run's owner is gone. Returns the
 * epoch to reconcile, or the result that ends reconciliation here.
 */
async function verifyOwnerLost(
  runDir: string,
  probe: ProcessLivenessProbe,
): Promise<LostOwnership | ReconcileResult> {
  const read = await readLease(runDir);
  if (read.kind === 'lease') {
    const verdict = await probe.check(leaseOwner(read.lease));
    if (verdict === 'alive') return { kind: 'owner_alive', pid: read.lease.owner.pid };
    // A reused PID reads as dead (its creation token differs) and is never signalled.
    if (verdict === 'unknown') return { kind: 'owner_unknown', pid: read.lease.owner.pid };
    return {
      epochSeq: read.lease.log_seq_at_claim,
      command: read.lease.command,
      claimedAt: read.lease.claimed_at,
      legacyLock: false,
    };
  }
  if (read.kind === 'corrupt') return { kind: 'owner_unknown', pid: null };

  // Legacy path: a pre-FEAT-064 `.lock`, or a `running` manifest with neither.
  const legacy = await readLegacyLock(runDir);
  if (legacy !== null) {
    // Without a start token a live PID cannot be verified as the owner.
    if (legacy.pid !== null && processExists(legacy.pid)) {
      return { kind: 'owner_unknown', pid: legacy.pid };
    }
    return { epochSeq: 0, command: null, claimedAt: null, legacyLock: true };
  }
  const manifest = await readRawManifest(runDir);
  if (manifest?.status === 'running') {
    // By the write-ordering invariant, a running manifest without a lease can
    // only mean an owner that died.
    return { epochSeq: 0, command: null, claimedAt: null, legacyLock: false };
  }
  return { kind: 'no_lease' };
}

async function readLegacyLock(runDir: string): Promise<{ readonly pid: number | null } | null> {
  let raw: string;
  try {
    raw = await readFile(join(runDir, LEGACY_LOCK_FILENAME), 'utf8');
  } catch {
    return null;
  }
  try {
    const pid = (JSON.parse(raw) as { pid?: unknown }).pid;
    return { pid: typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : null };
  } catch {
    return { pid: null };
  }
}

type TerminalEvent = Extract<RunEventType, { kind: 'run_outcome' }>;

/**
 * Scans the log above the epoch for the terminal event of the current
 * execution: the last `run_outcome` not followed by a `task_resumed`.
 */
async function scanEpoch(
  runDir: string,
  epochSeq: number,
): Promise<{ readonly terminal: TerminalEvent | null; readonly lastAt: string | null }> {
  let terminal: TerminalEvent | null = null;
  let lastAt: string | null = null;
  // Opening the writer first truncates a partial tail, so seq continues from
  // the last valid line (append-after-recovery).
  RunEventLog.open({ runDir, runId: 'reconcile' }).close();
  for await (const { event } of readCommittedEvents(runDir, epochSeq + 1)) {
    const at = (event as { at?: unknown }).at;
    if (typeof at === 'string') lastAt = at;
    if (event.kind === 'run_outcome') terminal = event as TerminalEvent;
    else if (event.kind === 'task_resumed') terminal = null;
  }
  return { terminal, lastAt };
}

function appendOutcome(
  runDir: string,
  runId: string,
  fields: {
    readonly outcome: TaskOutcome;
    readonly terminationReason: TerminationReason | null;
    readonly failureClass: FailureClass | null;
    readonly at: string;
  },
): void {
  const log = RunEventLog.open({ runDir, runId });
  try {
    log.append({
      kind: 'run_outcome',
      run_id: runId,
      task_outcome: fields.outcome,
      termination_reason: fields.terminationReason,
      stop_detail: null,
      exit_code: TASK_OUTCOME_TABLE[fields.outcome].exitCode,
      failure_class: fields.outcome === 'fulfilled' ? null : (fields.failureClass ?? 'unexpected'),
      at: fields.at,
    });
  } catch (error) {
    // The log already ends with an earlier epoch's outcome (a resumed owner
    // that died before writing anything): that line stays the record.
    if (!(error instanceof RunEventLogError && error.code === 'RUN_OUTCOME_DUPLICATE')) throw error;
  } finally {
    log.close();
  }
}

type RawManifest = Record<string, unknown>;

async function readRawManifest(runDir: string): Promise<RawManifest | null> {
  try {
    const parsed = JSON.parse(await readFile(join(runDir, 'manifest.json'), 'utf8')) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as RawManifest) : null;
  } catch {
    return null;
  }
}

function isTerminalManifest(manifest: RawManifest): boolean {
  return (
    (manifest.status === 'completed' ||
      manifest.status === 'failed' ||
      manifest.status === 'aborted') &&
    typeof manifest.taskOutcome === 'string' &&
    manifest.taskOutcome in TASK_OUTCOME_TABLE
  );
}

async function patchManifest(
  runDir: string,
  runId: string,
  manifest: RawManifest | null,
  lost: LostOwnership,
  result: {
    readonly outcome: TaskOutcome;
    readonly terminationReason: TerminationReason | null;
    readonly endedAt: string;
    readonly interrupted: boolean;
  },
): Promise<void> {
  const base: RawManifest = manifest ?? minimalManifest(runId, lost, result.endedAt);
  const startedAt = typeof base.startedAt === 'string' ? Date.parse(base.startedAt) : Number.NaN;
  const ended = Date.parse(result.endedAt);
  const patched: RawManifest = {
    ...base,
    status: TASK_OUTCOME_TABLE[result.outcome].manifestStatus,
    taskOutcome: result.outcome,
    ...(result.terminationReason === null ? {} : { terminationReason: result.terminationReason }),
    endedAt: result.endedAt,
    durationMs:
      Number.isFinite(startedAt) && Number.isFinite(ended)
        ? Math.max(0, ended - startedAt)
        : base.durationMs,
    ...(result.interrupted ? { executionState: 'interrupted' } : {}),
  };
  if (!result.interrupted) delete patched.executionState;
  if (JSON.stringify(patched) === JSON.stringify(manifest)) return;
  await writeFileAtomic(join(runDir, 'manifest.json'), JSON.stringify(patched, null, 2), {
    fsync: true,
  });
}

function minimalManifest(runId: string, lost: LostOwnership, endedAt: string): RawManifest {
  const command = lost.command ?? ['run'];
  return {
    runId,
    taskId: '',
    workflowName: command.join(' '),
    workflowVersion: null,
    params: {},
    startedAt: lost.claimedAt ?? endedAt,
    profileKind: 'ephemeral',
    cookieProfilePath: null,
    outputBindingNames: [],
    ...(command[0] === 'do' ? { runKind: 'agentic' } : {}),
  };
}

async function reapBrowsers(
  runDir: string,
  probe: ProcessLivenessProbe,
  deps: ReconcileDeps,
  clock: () => Date,
): Promise<{ readonly reaped: number; readonly uncertain: number }> {
  const owned = await readOwnedBrowsers(runDir);
  if (owned.length === 0) return { reaped: 0, uncertain: 0 };
  const terminator = deps.terminator ?? new NodeProcessTreeTerminator();
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const recorder = new FileBrowserOwnershipRecorder(runDir, clock);
  const verdicts = await checkIdentities(probe, owned);
  let reaped = 0;
  let uncertain = 0;
  for (const [index, identity] of owned.entries()) {
    const gone = await reapOne(identity, verdicts[index] ?? 'unknown', probe, terminator, sleep);
    if (gone) {
      await recorder.recordExited(identity);
      reaped += 1;
    } else {
      uncertain += 1;
    }
  }
  return { reaped, uncertain };
}

/** True once the browser is proved gone; false leaves it recorded and untouched. */
async function reapOne(
  identity: ProcessIdentity,
  verdict: 'alive' | 'dead' | 'unknown',
  probe: ProcessLivenessProbe,
  terminator: ProcessTreeTerminator,
  sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
  if (verdict === 'dead') return true;
  if (verdict === 'unknown') return false;
  // Re-verify immediately before acting: the PID must still be this browser.
  const recheck = await probe.check(identity);
  if (recheck === 'dead') return true;
  if (recheck === 'unknown') return false;
  await terminator.terminate(identity.pid).catch(() => undefined);
  const deadline = Date.now() + REAP_CONFIRM_MS;
  for (;;) {
    const after = await probe.check(identity);
    if (after === 'dead') return true;
    if (Date.now() >= deadline) return false;
    await sleep(100);
  }
}

function errorClass(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
