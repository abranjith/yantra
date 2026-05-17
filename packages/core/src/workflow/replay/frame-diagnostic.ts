/**
 * Frame diagnostic for locator-not-found failures.
 *
 * When a `locator_not_found` failure occurs, this module determines whether
 * the current page origin was in an "unrecorded" frame during recording.
 *
 * If so, the failure class is upgraded to `locator_miss_in_unrecorded_frame`
 * to give the user a more actionable error message.
 */

import type { WorkflowFile } from '@yantra/protocol';

import type { FailureDetail } from './types.js';

/**
 * Given a locator failure and the current page URL, diagnoses whether the
 * miss occurred on an unrecorded frame.
 *
 * Mutates `failure.failureClass` if an unrecorded frame is detected.
 *
 * @param currentPageUrl  The URL of the page when the locator failure occurred.
 * @param workflow        The loaded workflow (for `_unrecorded_frames`).
 * @param failure         The failure detail to potentially upgrade (mutated).
 */
export function diagnoseLocatorMiss(
  currentPageUrl: string,
  workflow: WorkflowFile,
  failure: FailureDetail,
): void {
  if (failure.failureClass !== 'locator_not_found') return;

  const unrecordedFrames: readonly string[] = workflow._unrecorded_frames ?? [];
  if (unrecordedFrames.length === 0) return;

  let currentOrigin: string;
  try {
    currentOrigin = new URL(currentPageUrl).origin;
  } catch {
    return;
  }

  const isUnrecorded = unrecordedFrames.some((frame) => {
    try {
      return new URL(frame).origin === currentOrigin;
    } catch {
      return false;
    }
  });

  if (isUnrecorded) {
    failure.failureClass = 'locator_miss_in_unrecorded_frame';
    failure.message =
      `Locator "${failure.locatorName ?? '(unknown)'}" was not found on origin ` +
      `"${currentOrigin}". This page was not recorded (it appears in ` +
      `\`_unrecorded_frames\`). Re-record the workflow to capture this frame.`;
  }
}
