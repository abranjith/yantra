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

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Plan } from '@yantra/protocol';
import type { FailureClass } from '@yantra/protocol';

import { FilesystemCheckpointStore } from '../../executor/checkpoint-store.js';

import { RunDirMissingError, RunNotResumableError } from './errors.js';
import type { ResumePoint, RunStore } from './types.js';

const RESUMABLE_STATUSES = new Set(['failed', 'paused']);

/**
 * Loads the information needed to resume a run.
 *
 * @throws RunDirMissingError if the run directory does not exist.
 * @throws RunNotResumableError if the run status is not 'failed' or 'paused',
 *   or if the workflow used `cookies: none`.
 */
export async function loadResumePoint(runStore: RunStore, runId: string): Promise<ResumePoint> {
  const found = await runStore.getRun(runId);
  if (found === null) {
    throw new RunDirMissingError(runId);
  }

  const { manifest, runDir } = found;

  if (!RESUMABLE_STATUSES.has(manifest.status)) {
    throw new RunNotResumableError(
      runId,
      manifest.status,
      `Run "${runId}" has status "${manifest.status}" which is not resumable. ` +
        `Only failed or paused runs can be resumed.`,
    );
  }

  // Workflows with cookies: none cannot be resumed — no session to restore
  if (manifest.profileKind === 'ephemeral') {
    throw new RunNotResumableError(
      runId,
      manifest.status,
      `Run "${runId}" used \`cookies: none\` (ephemeral profile) and cannot be resumed. ` +
        `Re-run the workflow instead: yantra run ${manifest.workflowName}`,
    );
  }

  // Load the original plan
  const planPath = join(runDir, 'plan.json');
  let plan: Plan;
  try {
    const raw = await readFile(planPath, 'utf8');
    plan = JSON.parse(raw) as Plan;
  } catch {
    throw new RunNotResumableError(
      runId,
      manifest.status,
      `Run "${runId}" plan.json could not be read. The run directory may be corrupted.`,
    );
  }

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

/**
 * Whether resuming a run with this failure class requires explicit user consent.
 *
 * Scope violations and ethics refusals need the user to acknowledge the
 * restriction before the run can be retried.
 */
export function requiresUserConsent(failureClass: FailureClass | undefined): boolean {
  if (!failureClass) return false;
  return failureClass === 'scope_violation' || failureClass === 'ethics_refused';
}
