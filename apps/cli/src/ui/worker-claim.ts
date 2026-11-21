/**
 * The app-launch path of the detached worker (FEAT-065 TASK-015, plan D11).
 *
 * When the app host started this worker, an invocation record exists for the
 * launch's invocation ID. Then, before any side effect:
 *
 * 1. **claim** it (`reserved | spawning → claimed`, recording this process's
 *    identity). A refused claim (the item was withdrawn or recovered) means
 *    another outcome already owns it: the worker exits 0 and does nothing.
 * 2. When the command claims its run's lease, record that run with
 *    `markRunning`. The claim is announced in-process by
 *    `RunOwnershipSession.open` (REV-011), so nothing scans run directories.
 * 3. After the command, the FEAT-064 result sink has written the result at
 *    `invocationResultPath(id)`; `finish` records the exit code.
 *
 * A launch with no invocation record is a plain FEAT-064 worker launch and
 * runs ungated.
 */

import {
  ClaimRefusedError,
  onRunLeaseClaimed,
  type FileInvocationStore,
  type ProcessIdentity,
} from '@yantra/core';
import type { RunLease, WorkerLaunch } from '@yantra/protocol';

import type { WorkerStartGate } from '../worker/entry.js';

export interface WorkerClaimDeps {
  readonly store: FileInvocationStore;
  /** This process's creation identity. */
  readonly identity: () => Promise<ProcessIdentity>;
  /** Subscribes to leases this process claims (default: core's in-process notice). */
  readonly onLeaseClaimed?: (listener: (lease: RunLease) => void) => () => void;
}

/** What the claim decided. */
export type ClaimDecision = 'not_app_launch' | 'claimed' | 'refused';

/** Claims the launch's invocation, if it is an app launch. */
export async function claimInvocation(
  launch: WorkerLaunch,
  deps: WorkerClaimDeps,
): Promise<ClaimDecision> {
  const id = launch.invocation.invocation_id;
  if ((await deps.store.get(id)) === null) return 'not_app_launch';
  try {
    await deps.store.claim(id, await deps.identity());
    return 'claimed';
  } catch (error) {
    if (error instanceof ClaimRefusedError) return 'refused';
    throw error;
  }
}

/** True when `lease` was claimed by `owner` since `since` (PID reuse safe). */
export function ownedBy(lease: RunLease, owner: ProcessIdentity, since: number): boolean {
  return (
    lease.owner.pid === owner.pid &&
    lease.owner.start_token === owner.startToken &&
    Date.parse(lease.claimed_at) >= since - 1_000
  );
}

/** The gate plus the bookkeeping around one app-launched command. */
export interface InvocationLifecycle {
  readonly gate: WorkerStartGate;
  /** Records the exit after the command finished (no-op when not claimed). */
  finish(exitCode: number): Promise<void>;
}

/** Builds the worker's gate and completion hook; see the module comment. */
export function invocationLifecycle(deps: WorkerClaimDeps): InvocationLifecycle {
  let claimedId: string | null = null;
  let stopListening: (() => void) | null = null;
  let marking: Promise<void> = Promise.resolve();
  const subscribe = deps.onLeaseClaimed ?? onRunLeaseClaimed;

  // The first run this process claims is the invocation's run; nested runs
  // a command opens later are not.
  const watch = (id: string, owner: ProcessIdentity, since: number): void => {
    stopListening = subscribe((lease) => {
      if (stopListening === null || !ownedBy(lease, owner, since)) return;
      stopListening();
      stopListening = null;
      marking = deps.store.markRunning(id, lease.run_id).then(
        () => undefined,
        () => undefined,
      );
    });
  };

  return {
    gate: async (launch) => {
      const decision = await claimInvocation(launch, deps);
      if (decision === 'refused') return false;
      if (decision === 'claimed') {
        claimedId = launch.invocation.invocation_id;
        watch(claimedId, await deps.identity(), Date.now());
      }
      return true;
    },
    finish: async (exitCode) => {
      stopListening?.();
      stopListening = null;
      // A fast command can end before its run was recorded; record it first.
      await marking;
      if (claimedId === null) return;
      await deps.store.finish(claimedId, { exitCode });
    },
  };
}
