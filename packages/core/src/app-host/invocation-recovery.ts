/**
 * Host-start recovery of app invocations (FEAT-065 TASK-014, plan D11).
 *
 * Runs under `slots.lock`, so a worker's claim and recovery can never both
 * win: exactly one of `claimed` or `never_started` results.
 *
 * - `reserved | spawning` with no worker claim → `never_started` (a worker
 *   that starts late finds its claim refused and exits with no effect).
 * - `claimed | running` whose worker the probe calls `alive` → `attach`.
 * - `dead` (a reused PID included) → `reconcile`: the caller runs FEAT-064
 *   `reconcileRun`, then `finish(…, owner_lost)`.
 * - `unknown` → `unverifiable`: nothing is changed. An unverifiable owner is
 *   never treated as dead (memory → Architecture), and the closed transition
 *   table has no `claimed → start_unknown`.
 */

import type { InvocationRecord } from '@yantra/protocol';

import type { ProcessLivenessProbe } from '../browser/installation-types.js';

import { type FileInvocationStore } from './invocation-store.js';

/** What recovery decided for one record. */
export type RecoveryVerdict =
  | { readonly kind: 'never_started'; readonly record: InvocationRecord }
  | { readonly kind: 'attach'; readonly record: InvocationRecord }
  | { readonly kind: 'reconcile'; readonly record: InvocationRecord }
  | { readonly kind: 'unverifiable'; readonly record: InvocationRecord };

export interface RecoveryDeps {
  readonly store: FileInvocationStore;
  readonly probe: ProcessLivenessProbe;
}

/** Recovers every in-flight invocation; see the module comment. */
export async function recoverInvocations(deps: RecoveryDeps): Promise<RecoveryVerdict[]> {
  return deps.store.withLock(async () => {
    const verdicts: RecoveryVerdict[] = [];
    for (const record of await deps.store.list()) {
      if (record.state === 'reserved' || record.state === 'spawning') {
        if (record.worker === null) {
          verdicts.push({
            kind: 'never_started',
            record: await deps.store.applyUnlocked(record, 'never_started'),
          });
        }
        continue;
      }
      if (record.state !== 'claimed' && record.state !== 'running') continue;
      if (record.worker === null) {
        verdicts.push({ kind: 'reconcile', record });
        continue;
      }
      const verdict = await deps.probe.check({
        pid: record.worker.pid,
        startToken: record.worker.start_token,
      });
      verdicts.push({
        kind: verdict === 'alive' ? 'attach' : verdict === 'dead' ? 'reconcile' : 'unverifiable',
        record,
      });
    }
    return verdicts;
  });
}
