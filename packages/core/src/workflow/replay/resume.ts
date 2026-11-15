/**
 * Resume-point loader.
 *
 * Rehydrates the state needed to continue a paused or failed run:
 * - The plan (from plan.json in the run directory)
 * - The last saved checkpoint
 * - Which step to resume from (the one after the checkpoint)
 * - Profile path for cookie rehydration
 *
 * @example
 * const point = await loadResumePoint(runStore, 'my-run-id');
 * // point.nextStepIndex, point.lastCheckpoint, point.plan, ...
 */

import { join } from 'node:path';

import { FilesystemCheckpointStore } from '../../executor/checkpoint-store.js';

import { RunDirMissingError, RunNotResumableError } from './errors.js';
import { checkResumable } from './resumability.js';
import type { ResumePoint, RunStore } from './types.js';

export { requiresUserConsent } from './resumability.js';

/**
 * Loads the information needed to resume a run. Whether it may resume is
 * decided by {@link checkResumable}, the one rule the app's Resume action
 * shares (FEAT-067).
 *
 * @throws RunDirMissingError if the run directory does not exist.
 * @throws RunNotResumableError if the run is not a resumable workflow run:
 *   its status is not 'failed' or 'paused', it is an agentic run, it used
 *   `cookies: none`, or its plan.json cannot be read.
 */
export async function loadResumePoint(runStore: RunStore, runId: string): Promise<ResumePoint> {
  const check = await checkResumable(runStore, runId);
  if (!check.available) {
    if (check.code === 'missing') throw new RunDirMissingError(runId);
    if (check.code === 'unreadable') throw check.error;
    throw new RunNotResumableError(runId, check.status ?? 'unknown', check.reason);
  }
  const { manifest, runDir, plan } = check;

  // Load last checkpoint
  const checkpointDir = join(runDir, 'checkpoints');
  const checkpointStore = new FilesystemCheckpointStore(checkpointDir);
  const lastCheckpoint = await checkpointStore.loadLast();

  // Compute next step index
  let nextStepIndex = 0;
  if (lastCheckpoint !== null) {
    const idx = plan.steps.findIndex((s) => s.id === lastCheckpoint.after_step_id);
    nextStepIndex = idx === -1 ? 0 : idx + 1;
  }

  return {
    runId,
    workflowName: manifest.workflowName,
    plan,
    nextStepIndex,
    lastCheckpoint,
    runDir,
    manifest,
    profileKind: manifest.profileKind as 'workflow',
    cookieProfilePath: manifest.cookieProfilePath ?? null,
  };
}
