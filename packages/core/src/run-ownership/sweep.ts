/**
 * Run-ownership sweeps (FEAT-064 TASK-010): reconcile every run whose owner
 * died, and answer "which runs are live?" and "which may have left a browser
 * behind?". Identity checks are batched (spike S2, RC4), so `yantra list`
 * with many leases costs about one platform query, not one per lease.
 */

import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { RunLease, RunLeaseOrigin } from '@yantra/protocol';

import type {
  LivenessVerdict,
  ProcessIdentity,
  ProcessLivenessProbe,
} from '../browser/installation-types.js';
import { runsRoot } from '../browser/paths.js';
import { NodeProcessLivenessProbe, checkIdentities } from '../browser/process-identity.js';
import type { ProcessTreeTerminator } from '../browser/process-lifecycle.js';
import type { Logger } from '../browser/types.js';

import { LEGACY_LOCK_FILENAME, RUN_LEASE_FILENAME } from './constants.js';
import { leaseOwner, readLease, readOwnedBrowsers } from './lease-store.js';
import { reconcileRun, type ReconcileHistory, type ReconcileResult } from './reconciler.js';
import type { ReconcileTrigger } from './runtime-record.js';

export interface SweepOptions {
  readonly trigger: ReconcileTrigger;
  /** Stop starting new reconciliations after this long; every step is idempotent. */
  readonly budgetMs?: number;
  /** Also reconcile `running` manifests that have no lease and no `.lock` (legacy). */
  readonly includeRunningManifests?: boolean;
  readonly root?: string;
  readonly probe?: ProcessLivenessProbe;
  readonly terminator?: ProcessTreeTerminator;
  readonly history?: ReconcileHistory | null;
  readonly logger?: Logger;
  /** Monotonic ms clock seam for the budget. */
  readonly now?: () => number;
  /** This process's PID; its own leases are never reconciled. */
  readonly ownPid?: number;
  readonly reconcile?: typeof reconcileRun;
}

export interface SweepResult {
  readonly scanned: number;
  readonly reconciled: readonly string[];
  /** True when the budget ran out before every candidate was visited. */
  readonly truncated: boolean;
}

interface LeasedRun {
  readonly runId: string;
  readonly runDir: string;
  readonly lease: RunLease;
}

async function runDirs(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** Every run directory with a readable lease, by `stat`-cheap checks first. */
async function leasedRuns(root: string): Promise<LeasedRun[]> {
  const out: LeasedRun[] = [];
  for (const runId of await runDirs(root)) {
    const runDir = join(root, runId);
    if (!existsSync(join(runDir, RUN_LEASE_FILENAME))) continue;
    const read = await readLease(runDir).catch(() => null);
    if (read?.kind === 'lease') out.push({ runId, runDir, lease: read.lease });
  }
  return out;
}

async function verdicts(
  runs: readonly LeasedRun[],
  probe: ProcessLivenessProbe,
): Promise<LivenessVerdict[]> {
  return checkIdentities(
    probe,
    runs.map((run) => leaseOwner(run.lease)),
  );
}

async function isRunningManifest(runDir: string): Promise<boolean> {
  try {
    const manifest = JSON.parse(await readFile(join(runDir, 'manifest.json'), 'utf8')) as {
      status?: unknown;
    };
    return manifest.status === 'running';
  } catch {
    return false;
  }
}

/**
 * Reconciles every run whose owner is dead: leases with a dead owner, legacy
 * `.lock` files, and (when asked) `running` manifests with neither. Skips
 * this process's own leases and every live or unverifiable owner. Abandoning
 * mid-sweep at the budget is safe because every reconcile step is idempotent.
 */
export async function reconcileAll(options: SweepOptions): Promise<SweepResult> {
  const root = options.root ?? runsRoot();
  const now = options.now ?? (() => performance.now());
  const started = now();
  const probe = options.probe ?? new NodeProcessLivenessProbe();
  const ownPid = options.ownPid ?? process.pid;
  const reconcile = options.reconcile ?? reconcileRun;

  const leased = await leasedRuns(root);
  const leaseVerdicts = await verdicts(leased, probe);
  const candidates: string[] = leased
    .filter((run, index) => run.lease.owner.pid !== ownPid && leaseVerdicts[index] === 'dead')
    .map((run) => run.runDir);
  const leasedIds = new Set(leased.map((run) => run.runId));
  for (const runId of await runDirs(root)) {
    if (leasedIds.has(runId)) continue;
    const runDir = join(root, runId);
    if (existsSync(join(runDir, LEGACY_LOCK_FILENAME))) candidates.push(runDir);
    else if (options.includeRunningManifests === true && (await isRunningManifest(runDir))) {
      candidates.push(runDir);
    }
  }

  const reconciled: string[] = [];
  let truncated = false;
  for (const runDir of candidates) {
    if (options.budgetMs !== undefined && now() - started >= options.budgetMs) {
      truncated = true;
      break;
    }
    let result: ReconcileResult;
    try {
      result = await reconcile(runDir, {
        trigger: options.trigger,
        probe,
        ...(options.terminator === undefined ? {} : { terminator: options.terminator }),
        ...(options.history === undefined ? {} : { history: options.history }),
        ...(options.logger === undefined ? {} : { logger: options.logger }),
      });
    } catch (error) {
      options.logger?.debug(
        {
          event: 'reconcile_failed',
          error_class: error instanceof Error ? error.name : typeof error,
        },
        'reconcile_failed',
      );
      continue;
    }
    if (result.kind === 'reconciled' || result.kind === 'completed_by_evidence') {
      reconciled.push(runDir.split(/[\\/]/u).at(-1) ?? runDir);
    }
  }
  return { scanned: candidates.length, reconciled, truncated };
}

/** A run whose owner is gone but whose browser may still be running. */
export interface PossibleOrphan {
  readonly runId: string;
  readonly runDir: string;
  readonly browsers: readonly ProcessIdentity[];
}

/** Leases with a dead owner that still record browsers not proved exited (FEAT-071 Health). */
export async function listPossibleOrphans(
  options: { readonly root?: string; readonly probe?: ProcessLivenessProbe } = {},
): Promise<PossibleOrphan[]> {
  const probe = options.probe ?? new NodeProcessLivenessProbe();
  const leased = await leasedRuns(options.root ?? runsRoot());
  const owners = await verdicts(leased, probe);
  const out: PossibleOrphan[] = [];
  for (const [index, run] of leased.entries()) {
    if (owners[index] !== 'dead') continue;
    const browsers = await readOwnedBrowsers(run.runDir);
    if (browsers.length > 0) out.push({ runId: run.runId, runDir: run.runDir, browsers });
  }
  return out;
}

/** A run whose owner is alive, or cannot be verified dead. */
export interface LiveOwner {
  readonly runId: string;
  readonly pid: number;
  readonly origin: RunLeaseOrigin;
  readonly verdict: 'alive' | 'unknown';
}

/** Leases whose owner is alive or unverifiable (the D15 `config data-dir` guard). */
export async function findLiveOwners(
  options: { readonly root?: string; readonly probe?: ProcessLivenessProbe } = {},
): Promise<LiveOwner[]> {
  const probe = options.probe ?? new NodeProcessLivenessProbe();
  const leased = await leasedRuns(options.root ?? runsRoot());
  const owners = await verdicts(leased, probe);
  const out: LiveOwner[] = [];
  for (const [index, run] of leased.entries()) {
    const verdict = owners[index];
    if (verdict === 'alive' || verdict === 'unknown') {
      out.push({ runId: run.runId, pid: run.lease.owner.pid, origin: run.lease.origin, verdict });
    }
  }
  return out;
}

/** The manifest's `executionState`, when a reconciler set one. */
export async function readExecutionState(runDir: string): Promise<'interrupted' | undefined> {
  try {
    const manifest = JSON.parse(await readFile(join(runDir, 'manifest.json'), 'utf8')) as {
      executionState?: unknown;
    };
    return manifest.executionState === 'interrupted' ? 'interrupted' : undefined;
  } catch {
    return undefined;
  }
}
