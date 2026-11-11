/**
 * Host-start recovery (FEAT-065 TASK-016, plan D4, D11), run after
 * `markReady` and before the dequeue loop resumes:
 *
 * 1. `recoverInvocations` under `slots.lock`: unclaimed starts become
 *    `never_started`; live workers are left to the relay (`attach`).
 * 2. Each `reconcile` verdict: FEAT-064 `reconcileRun` on its run (when it
 *    has one), then `finish(…, owner_lost)`.
 * 3. A count of runs that still hold a lease, for `host.log`.
 *
 * Host start never spawns anything itself: queued items start only through
 * the normal dequeue loop, which still runs drift review and the slot
 * reservation for each.
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import {
  reconcileRun,
  recoverInvocations,
  type FileInvocationStore,
  type ProcessLivenessProbe,
  type RecoveryVerdict,
} from '@yantra/core';

import type { HostLogger } from './host.js';

/** Exit code recorded for an invocation whose worker died (execution failure). */
export const OWNER_LOST_EXIT_CODE = 2;

export interface HostRecoveryDeps {
  readonly store: FileInvocationStore;
  readonly probe: ProcessLivenessProbe;
  readonly runsRoot: string;
  readonly logger: HostLogger;
  readonly reconcile?: typeof reconcileRun;
}

/** What recovery did, for logs and tests. */
export interface HostRecoveryReport {
  readonly verdicts: readonly RecoveryVerdict['kind'][];
  readonly reconciled: readonly string[];
  readonly liveLeases: number;
}

/** See the module comment. */
export async function recoverHost(deps: HostRecoveryDeps): Promise<HostRecoveryReport> {
  const verdicts = await recoverInvocations({ store: deps.store, probe: deps.probe });
  const reconciled: string[] = [];
  for (const verdict of verdicts) {
    if (verdict.kind !== 'reconcile') continue;
    const { record } = verdict;
    if (record.run_id !== null) {
      const result = await (deps.reconcile ?? reconcileRun)(join(deps.runsRoot, record.run_id), {
        trigger: 'host',
        probe: deps.probe,
      }).catch(() => null);
      deps.logger.info(
        {
          invocation_id: record.invocation_id,
          run_id: record.run_id,
          result: result?.kind ?? 'failed',
        },
        'reconciliation',
      );
    }
    await deps.store
      .finish(record.invocation_id, { exitCode: OWNER_LOST_EXIT_CODE, reason: 'owner_lost' })
      .then(() => reconciled.push(record.invocation_id))
      .catch(() => undefined);
  }
  const liveLeases = await countLeases(deps.runsRoot);
  deps.logger.info(
    {
      never_started: verdicts.filter((v) => v.kind === 'never_started').length,
      attach: verdicts.filter((v) => v.kind === 'attach').length,
      reconciled: reconciled.length,
      unverifiable: verdicts.filter((v) => v.kind === 'unverifiable').length,
      live_leases: liveLeases,
    },
    'host recovery',
  );
  return { verdicts: verdicts.map((v) => v.kind), reconciled, liveLeases };
}

async function countLeases(runsRoot: string): Promise<number> {
  let names: string[];
  try {
    names = await readdir(runsRoot);
  } catch {
    return 0;
  }
  const present = await Promise.all(
    names.map((name) =>
      readdir(join(runsRoot, name))
        .then((entries) => entries.includes('lease.json'))
        .catch(() => false),
    ),
  );
  return present.filter(Boolean).length;
}
