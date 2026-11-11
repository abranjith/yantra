/**
 * Stopping a run (FEAT-064 TASK-011, plan §8 reliability matrix): ask its
 * owner to cancel, give it a grace period to end cleanly, then terminate it by
 * verified identity, and always reconcile after a forced stop. A core service
 * for the app (FEAT-065, FEAT-067); there is no CLI command.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { RunLease, TaskOutcome } from '@yantra/protocol';

import type { ProcessLivenessProbe } from '../browser/installation-types.js';
import { NodeProcessLivenessProbe } from '../browser/process-identity.js';
import {
  NodeProcessTreeTerminator,
  type ProcessTreeTerminator,
} from '../browser/process-lifecycle.js';
import type { Logger } from '../browser/types.js';
import {
  RunChannelClient,
  type CancelAck,
  type ChannelConnectResult,
} from '../run-channel/client.js';

import { REAP_CONFIRM_MS, STOP_GRACE_MS } from './constants.js';
import { leaseOwner, readLease } from './lease-store.js';
import { reconcileRun, type ReconcileHistory, type ReconcileResult } from './reconciler.js';

export type StopResult =
  /** There was no lease: nothing owns the run. */
  | { readonly kind: 'not_running' }
  /** The owner ended the run itself within the grace period. */
  | { readonly kind: 'stopped_gracefully'; readonly outcome: TaskOutcome | null }
  /** The owner's identity cannot be verified, so nothing was signalled. */
  | { readonly kind: 'stop_unverifiable'; readonly pid: number | null }
  /** The owner was terminated (or found dead) and the run reconciled. */
  | { readonly kind: 'stopped_forcefully'; readonly reconcile: ReconcileResult };

/** The part of a run-channel client a stop uses. */
export interface StopChannel {
  connect(lease: RunLease): Promise<ChannelConnectResult>;
  cancel(): Promise<CancelAck | null>;
  close(): void;
}

export interface StopDeps {
  readonly probe?: ProcessLivenessProbe;
  readonly terminator?: ProcessTreeTerminator;
  /** Builds the client used to send `cancel`. */
  readonly channel?: (runDir: string) => StopChannel;
  readonly reconcile?: typeof reconcileRun;
  readonly history?: ReconcileHistory | null;
  readonly logger?: Logger;
  /** Monotonic ms clock seam. */
  readonly now?: () => number;
  /** Delay seam. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const POLL_MS = 100;

/**
 * Stops the run in `runDir`. See the module comment; the steps are:
 * 1. no lease → `not_running`;
 * 2. connect and send `cancel` (never to an owner this client cannot speak to);
 * 3. wait up to `graceMs` for the lease to disappear — skipped when the owner
 *    answered `honored: false`, because that handler cannot stop cleanly;
 * 4. verify the owner: `unknown` → `stop_unverifiable` (never signalled),
 *    `dead` → no signal, `alive` → re-verify, terminate, wait for `dead`;
 * 5. always reconcile.
 */
export async function stopRun(
  options: { readonly runDir: string; readonly graceMs?: number },
  deps: StopDeps = {},
): Promise<StopResult> {
  const { runDir } = options;
  const graceMs = options.graceMs ?? STOP_GRACE_MS;
  const probe = deps.probe ?? new NodeProcessLivenessProbe();
  const now = deps.now ?? (() => performance.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const read = await readLease(runDir);
  if (read.kind === 'absent') return { kind: 'not_running' };
  if (read.kind === 'corrupt') return { kind: 'stop_unverifiable', pid: null };
  const lease = read.lease;

  // 2–3. Cooperative cancel and grace.
  const graceful = await cancelAndWait(runDir, lease, graceMs, deps, now, sleep);
  if (graceful) {
    return { kind: 'stopped_gracefully', outcome: await manifestOutcome(runDir) };
  }

  // 4. Identity-verified termination.
  const owner = leaseOwner(lease);
  const verdict = await probe.check(owner);
  if (verdict === 'unknown') return { kind: 'stop_unverifiable', pid: owner.pid };
  if (verdict === 'alive') {
    const recheck = await probe.check(owner);
    if (recheck === 'unknown') return { kind: 'stop_unverifiable', pid: owner.pid };
    if (recheck === 'alive') {
      try {
        await (deps.terminator ?? new NodeProcessTreeTerminator()).terminate(owner.pid);
      } catch (error) {
        deps.logger?.warn(
          {
            event: 'stop_terminate_failed',
            error_class: error instanceof Error ? error.name : typeof error,
          },
          'stop_terminate_failed',
        );
      }
      const deadline = now() + REAP_CONFIRM_MS;
      while ((await probe.check(owner)) !== 'dead' && now() < deadline) await sleep(POLL_MS);
    }
  }

  // 5. Always reconcile; it reaps the run's browsers by identity.
  const reconcile = await (deps.reconcile ?? reconcileRun)(runDir, {
    trigger: 'stop',
    probe,
    ...(deps.terminator === undefined ? {} : { terminator: deps.terminator }),
    ...(deps.history === undefined ? {} : { history: deps.history }),
    ...(deps.logger === undefined ? {} : { logger: deps.logger }),
  });
  return { kind: 'stopped_forcefully', reconcile };
}

/** True when the owner removed its lease (ended the run) within the grace period. */
async function cancelAndWait(
  runDir: string,
  lease: RunLease,
  graceMs: number,
  deps: StopDeps,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
  const channel =
    deps.channel?.(runDir) ??
    new RunChannelClient({
      clientKind: 'host',
      runDir,
      ...(deps.logger === undefined ? {} : { logger: deps.logger }),
    });
  const started = now();
  try {
    const connected = await channel.connect(lease);
    // An owner this client cannot speak to gets nothing, never `cancel`.
    if (connected.state !== 'attached') return false;
    // An owner that never acknowledges still gets only the grace period.
    let acknowledged = false;
    const ack = await Promise.race([
      channel.cancel().finally(() => {
        acknowledged = true;
      }),
      (async () => {
        await waitUntil(() => acknowledged || now() - started >= graceMs, now, sleep);
        return null;
      })(),
    ]);
    acknowledged = true;
    if (ack?.honored === false) return false;
    return await waitUntil(
      async () => (await readLease(runDir)).kind === 'absent',
      now,
      sleep,
      started + graceMs,
    );
  } finally {
    channel.close();
  }
}

/** Polls `done` until it holds (true) or `deadline` passes (false). */
async function waitUntil(
  done: () => boolean | Promise<boolean>,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
  deadline = Number.POSITIVE_INFINITY,
): Promise<boolean> {
  for (;;) {
    if (await done()) return true;
    if (now() >= deadline) return false;
    await sleep(POLL_MS);
  }
}

async function manifestOutcome(runDir: string): Promise<TaskOutcome | null> {
  try {
    const manifest = JSON.parse(await readFile(join(runDir, 'manifest.json'), 'utf8')) as {
      taskOutcome?: TaskOutcome;
    };
    return manifest.taskOutcome ?? null;
  } catch {
    return null;
  }
}
