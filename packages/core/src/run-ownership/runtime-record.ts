import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';

/** The operator log every run directory may hold (FEAT-048). */
export const RUNTIME_LOG_FILENAME = 'runtime.jsonl';

/** How a reconciler decided a dead owner's run ended. */
export type ReconcileEvidence = 'event' | 'manifest' | 'owner_lost';

/** Who triggered a reconciliation. */
export type ReconcileTrigger = 'host' | 'cli' | 'list' | 'stop' | 'resume';

/** One `reconciled` line: closed fields only, never a path, token or address. */
export interface ReconciledRecord {
  readonly by: ReconcileTrigger;
  readonly evidence: ReconcileEvidence;
  /** Owned browsers the reconciler terminated or found already gone. */
  readonly reaped: number;
  /** Owned browsers whose identity could not be verified; left untouched. */
  readonly uncertain: number;
  readonly at: string;
}

/**
 * Appends one `reconciled` line to a run's `runtime.jsonl` from core, in the
 * same envelope the agent's runtime logger writes (`schema_version: 1`).
 */
export async function appendReconciledRecord(
  runDir: string,
  record: ReconciledRecord,
): Promise<void> {
  const line = { schema_version: 1, event: 'reconciled', ...record };
  await appendFile(join(runDir, RUNTIME_LOG_FILENAME), `${JSON.stringify(line)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}
