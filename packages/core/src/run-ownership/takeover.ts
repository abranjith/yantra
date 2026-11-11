import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { RunLease } from '@yantra/protocol';

import { NodeProcessLivenessProbe } from '../browser/process-identity.js';
import type { Logger } from '../browser/types.js';
import { RUN_EVENTS_FILENAME } from '../run-events/log.js';
import { scanRunEventsTail } from '../run-events/reader.js';

import { RUN_LEASE_FILENAME } from './constants.js';
import { RunLeaseHeldError, RunOwnershipError } from './errors.js';
import {
  buildLease,
  claimLease,
  heldError,
  ownerVerdict,
  publishLease,
  readLease,
  type LeaseClaimDeps,
  type LeaseClaimInit,
} from './lease-store.js';
import { acquireReconcileLock, reconcileRun, type ReconcileHistory } from './reconciler.js';

export interface TakeoverDeps extends LeaseClaimDeps {
  readonly logger?: Logger;
  readonly history?: ReconcileHistory | null;
  /** Seams passed to the reconciler (tests). */
  readonly reconcile?: typeof reconcileRun;
}

/**
 * Claims an existing run directory for `resume` (FEAT-064 TASK-010).
 *
 * - No lease: a plain exclusive claim; of two concurrent claimants exactly
 *   one wins.
 * - A lease whose owner is alive or cannot be verified: busy
 *   ({@link RunLeaseHeldError}, exit 3), naming the holder.
 * - A dead owner: under `reconcile.lock`, the run is reconciled first (its
 *   ending recorded, its browsers reaped by identity), then the lease is
 *   replaced by unlink and exclusive `link`, never by rename (spike S2, RC2).
 *   Browsers whose identity stayed uncertain remain in `owned-browsers.jsonl`,
 *   so a possible orphan stays tracked under the new owner.
 *
 * `log_seq_at_claim` is read after any reconciliation, so the new epoch
 * starts above the ending a reconciler wrote.
 */
export async function claimExistingRun(
  runDir: string,
  init: LeaseClaimInit,
  deps: TakeoverDeps = {},
): Promise<RunLease> {
  const probe = deps.probe ?? new NodeProcessLivenessProbe();
  const current = await readLease(runDir);
  if (current.kind === 'absent') {
    return claimLease(runDir, { ...init, logSeqAtClaim: tailSeq(runDir) }, { ...deps, probe });
  }
  if (current.kind === 'corrupt') throw new RunLeaseHeldError(init.runId, null, 'corrupt');
  const verdict = await ownerVerdict(current.lease, probe);
  if (verdict !== 'dead') throw new RunLeaseHeldError(init.runId, current.lease, verdict);

  const release = await acquireReconcileLock(runDir);
  if (release === null) throw await heldError(runDir, init.runId, probe);
  try {
    const result = await (deps.reconcile ?? reconcileRun)(runDir, {
      trigger: 'resume',
      probe,
      lockHeld: true,
      ...(deps.logger === undefined ? {} : { logger: deps.logger }),
      ...(deps.history === undefined ? {} : { history: deps.history }),
    });
    if (result.kind === 'owner_alive' || result.kind === 'owner_unknown') {
      throw await heldError(runDir, init.runId, probe);
    }
    const lease = await buildLease({ ...init, logSeqAtClaim: tailSeq(runDir) }, deps);
    // Every claimant of an existing run holds reconcile.lock before acting and
    // re-reads afterwards, so the moment with no lease is never reconciled.
    await rm(join(runDir, RUN_LEASE_FILENAME), { force: true });
    try {
      await publishLease(runDir, lease);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw await heldError(runDir, init.runId, probe);
      }
      throw new RunOwnershipError(
        'RUN_OWNERSHIP_CLAIM_FAILED',
        `Could not take over run ${init.runId}: ${(error as NodeJS.ErrnoException).code ?? 'error'}`,
        { cause: error },
      );
    }
    return lease;
  } finally {
    await release().catch(() => undefined);
  }
}

function tailSeq(runDir: string): number {
  return scanRunEventsTail(join(runDir, RUN_EVENTS_FILENAME)).lastSeq;
}
