/**
 * Chrome version drift detection.
 *
 * Compares the actual browser's major version against the version recorded
 * in the workflow's `recorded_with` metadata.
 *
 * Drift is advisory-only — the run is NOT aborted. A `chrome_drift_warning`
 * event is emitted so downstream consumers (report, CLI) can surface the info.
 */

import type { WorkflowFile } from '@yantra/protocol';

import type { EventBus } from '../../executor/types.js';

import type { RunManifest } from './types.js';

/** Result of the chrome drift check. */
export interface ChromeDriftResult {
  /** Whether drift was detected (|current − recorded| > 2). */
  hasDrift: boolean;
  /** The recorded Chrome major version, or null if not tracked. */
  recorded: number | null;
  /** The current browser's major version. */
  current: number;
  /** The absolute difference in major versions. */
  drift: number;
}

const DRIFT_THRESHOLD = 2;

/**
 * Checks for Chrome major-version drift between recording and playback.
 *
 * When drift is detected, emits a `chrome_drift_warning` TaskEvent and
 * attaches the warning to the run manifest.
 *
 * If `workflow.recorded_with` is null/undefined, the check is silently skipped.
 *
 * @param chromeMajor  Current browser major version (e.g. `128`).
 * @param workflow     The loaded workflow (for `recorded_with.chromeMajor`).
 * @param manifest     The live run manifest to update (mutated in-place).
 * @param events       Event bus for broadcasting the warning event.
 */
export function checkChromeDrift(
  chromeMajor: number,
  workflow: WorkflowFile,
  manifest: RunManifest,
  events: EventBus,
): ChromeDriftResult {
  const recorded = workflow.recorded_with?.chrome_major ?? null;

  if (recorded === null) {
    return { hasDrift: false, recorded: null, current: chromeMajor, drift: 0 };
  }

  const drift = Math.abs(chromeMajor - recorded);
  if (drift <= DRIFT_THRESHOLD) {
    return { hasDrift: false, recorded, current: chromeMajor, drift };
  }

  // Mutate the manifest so the warning is persisted
  manifest.chromeDriftWarning = {
    recorded,
    current: chromeMajor,
  };

  // Emit the task event
  events.publish({
    kind: 'chrome_drift_warning',
    task_id: manifest.taskId,
    at: new Date().toISOString(),
    recorded_chrome_major: recorded,
    current_chrome_major: chromeMajor,
    drift,
  });

  return { hasDrift: true, recorded, current: chromeMajor, drift };
}
