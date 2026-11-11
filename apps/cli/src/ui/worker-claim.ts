/**
 * The app-launch path of the detached worker (FEAT-065 TASK-015, plan D11).
 *
 * When the app host started this worker, an invocation record exists for the
 * launch's invocation ID. Then, before any side effect:
 *
 * 1. **claim** it (`reserved | spawning → claimed`, recording this process's
 *    identity). A refused claim (the item was withdrawn or recovered) means
 *    another outcome already owns it: the worker exits 0 and does nothing.
 * 2. While the command runs, find the run this process owns (the lease whose
 *    owner is this process) and record it with `markRunning`.
 * 3. After the command, the FEAT-064 result sink has written the result at
 *    `invocationResultPath(id)`; `finish` records the exit code.
 *
 * A launch with no invocation record is a plain FEAT-064 worker launch and
 * runs ungated.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ClaimRefusedError, type FileInvocationStore, type ProcessIdentity } from '@yantra/core';
import { RunLease, type WorkerLaunch } from '@yantra/protocol';

import type { WorkerStartGate } from '../worker/entry.js';

export interface WorkerClaimDeps {
  readonly store: FileInvocationStore;
  /** This process's creation identity. */
  readonly identity: () => Promise<ProcessIdentity>;
  readonly runsRoot: string;
  readonly pollMs?: number;
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

/**
 * The run directory whose lease this process owns, or null. Only directories
 * claimed after `since` are considered.
 */
export async function findOwnedRun(
  runsRoot: string,
  owner: ProcessIdentity,
  since: number,
): Promise<string | null> {
  let names: string[];
  try {
    names = await readdir(runsRoot);
  } catch {
    return null;
  }
  for (const name of names) {
    try {
      const parsed = RunLease.safeParse(
        JSON.parse(await readFile(join(runsRoot, name, 'lease.json'), 'utf8')) as unknown,
      );
      if (
        parsed.success &&
        parsed.data.owner.pid === owner.pid &&
        parsed.data.owner.start_token === owner.startToken &&
        Date.parse(parsed.data.claimed_at) >= since - 1_000
      ) {
        return parsed.data.run_id;
      }
    } catch {
      // No lease (yet), or a run that is not this process's.
    }
  }
  return null;
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
  let watcher: NodeJS.Timeout | null = null;
  let running = false;

  const watch = (id: string, owner: ProcessIdentity, since: number): void => {
    const tick = async (): Promise<void> => {
      const runId = await findOwnedRun(deps.runsRoot, owner, since);
      if (runId === null || running) return;
      running = true;
      if (watcher !== null) clearInterval(watcher);
      await deps.store.markRunning(id, runId).catch(() => {
        running = false;
      });
    };
    watcher = setInterval(() => {
      void tick();
    }, deps.pollMs ?? 250);
    watcher.unref();
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
      if (watcher !== null) clearInterval(watcher);
      if (claimedId === null) return;
      await deps.store.finish(claimedId, { exitCode });
    },
  };
}
