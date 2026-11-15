/**
 * Whether a run can be resumed: the one rule (FEAT-067 TASK-013).
 *
 * `yantra resume` (through {@link loadResumePoint}) and the app's Resume
 * action both ask this module, so they cannot disagree. A run resumes when
 * all of these hold:
 *
 * - it is a saved-workflow run (agentic `ask`/`research`/`do` runs are never
 *   resumable; Run again starts them afresh);
 * - its status is `failed` or `paused`;
 * - its profile is not ephemeral (`cookies: none` has no session to restore);
 * - its `plan.json` is readable.
 *
 * A missing checkpoint resumes from step 0. A `scope_violation` or
 * `ethics_refused` failure does not forbid resume: it requires consent
 * (`--force`).
 *
 * {@link checkResumable} never throws; {@link assessResumability} is its
 * public, serializable projection.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { FailureClass, Plan } from '@yantra/protocol';

import type { RunManifest, RunStore } from './types.js';

const RESUMABLE_STATUSES = new Set(['failed', 'paused']);

/** The reason given for a run that is not a saved-workflow run. */
export const NOT_A_WORKFLOW_RUN = 'Only saved workflow runs can be resumed. Use Run again.';

/** Why a run cannot be resumed. */
export type NotResumableCode =
  | 'missing'
  | 'unreadable'
  | 'agentic'
  | 'status'
  | 'ephemeral'
  | 'plan';

/** The full verdict, with what resuming needs (internal to core). */
export type ResumeCheck =
  | {
      readonly available: false;
      readonly code: NotResumableCode;
      readonly reason: string;
      /** The run's status, when its manifest was read. */
      readonly status: string | null;
      /** What reading the manifest threw (`unreadable`), so callers can rethrow it. */
      readonly error?: unknown;
    }
  | {
      readonly available: true;
      readonly requiresConsent: boolean;
      readonly failureClass: FailureClass | undefined;
      readonly manifest: RunManifest;
      readonly runDir: string;
      readonly plan: Plan;
    };

/** The public verdict (`read.run_recovery`). */
export type Resumability =
  | { readonly available: false; readonly reason: string }
  | {
      readonly available: true;
      readonly requiresConsent: boolean;
      readonly failureClass?: FailureClass;
    };

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

/** The full check; never throws. See the module comment. */
export async function checkResumable(runStore: RunStore, runId: string): Promise<ResumeCheck> {
  let found: Awaited<ReturnType<RunStore['getRun']>>;
  try {
    found = await runStore.getRun(runId);
  } catch (error) {
    return {
      available: false,
      code: 'unreadable',
      reason: `Run "${runId}" has a manifest that could not be read.`,
      status: null,
      error,
    };
  }
  if (found === null) {
    return {
      available: false,
      code: 'missing',
      reason: `There is no run "${runId}".`,
      status: null,
    };
  }
  const { manifest, runDir } = found;

  if (!RESUMABLE_STATUSES.has(manifest.status)) {
    return {
      available: false,
      code: 'status',
      reason:
        `Run "${runId}" has status "${manifest.status}" which is not resumable. ` +
        `Only failed or paused runs can be resumed.`,
      status: manifest.status,
    };
  }

  if (manifest.runKind === 'agentic') {
    return {
      available: false,
      code: 'agentic',
      reason: NOT_A_WORKFLOW_RUN,
      status: manifest.status,
    };
  }

  // Workflows with cookies: none cannot be resumed — no session to restore
  if (manifest.profileKind === 'ephemeral') {
    return {
      available: false,
      code: 'ephemeral',
      reason:
        `Run "${runId}" used \`cookies: none\` (ephemeral profile) and cannot be resumed. ` +
        `Re-run the workflow instead: yantra run ${manifest.workflowName}`,
      status: manifest.status,
    };
  }

  let plan: Plan;
  try {
    plan = JSON.parse(await readFile(join(runDir, 'plan.json'), 'utf8')) as Plan;
  } catch {
    return {
      available: false,
      code: 'plan',
      reason: `Run "${runId}" plan.json could not be read. The run directory may be corrupted.`,
      status: manifest.status,
    };
  }

  return {
    available: true,
    requiresConsent: requiresUserConsent(manifest.failureClass),
    failureClass: manifest.failureClass,
    manifest,
    runDir,
    plan,
  };
}

/** Whether `runId` can be resumed now; never throws. See the module comment. */
export async function assessResumability(runStore: RunStore, runId: string): Promise<Resumability> {
  const check = await checkResumable(runStore, runId);
  if (!check.available) return { available: false, reason: check.reason };
  return {
    available: true,
    requiresConsent: check.requiresConsent,
    ...(check.failureClass === undefined ? {} : { failureClass: check.failureClass }),
  };
}
