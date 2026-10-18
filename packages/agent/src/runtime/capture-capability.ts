/**
 * The run's two capture capabilities (FEAT-058 D2), resolved once before the
 * tool catalog exists and recorded in the manifest and `run-health.json`.
 *
 * - **Vision Assist** (`browser_screenshot`) sends pixels to the model. Its
 *   five-condition gate lives in `vision.ts` and is unchanged.
 * - **Deliverable capture** (`browser_capture`) saves a clean PNG on this
 *   computer and never transmits it. It is available iff the run has a
 *   browser, its profile includes an interaction tool, and
 *   `--no-screenshots` is absent (S2). The stored grant and the model's image
 *   capability are deliberately not conditions: the grant governs model
 *   transmission only.
 *
 * Pure and fail closed: only literal `true` inputs enable anything.
 */

import type { DeliverableCaptureReason, CaptureCapabilityRecord } from '@yantra/protocol';

import type { VisionAvailability, VisionReason } from './vision.js';

/** A condition that keeps deliverable capture off. */
export type DeliverableReason = DeliverableCaptureReason;

/** One capability decision: `reasons` is empty exactly when `available`. */
export interface CapabilityDecision<Reason extends string> {
  readonly available: boolean;
  readonly reasons: readonly Reason[];
}

/** Both capture decisions for one run. */
export interface CaptureCapability {
  readonly visionAssist: CapabilityDecision<VisionReason>;
  readonly deliverable: CapabilityDecision<DeliverableReason>;
}

/** Inputs to {@link resolveCaptureCapability}. */
export interface CaptureCapabilityInput {
  /** The run's resolved Vision Assist decision. */
  readonly vision: Pick<VisionAvailability, 'available' | 'reasons'>;
  /** True when the run has a browser (`domain.browser !== null`). */
  readonly hasBrowser: boolean;
  /** True when the profile includes `browser_click`, `browser_fill_element`, or `browser_fill_form`. */
  readonly hasInteractionTools: boolean;
  /** True under `--no-screenshots`. */
  readonly suppressedByFlag: boolean;
}

/**
 * Resolves both capture capabilities. Deliverable reasons are recorded in a
 * fixed order: `suppressed_by_flag`, `no_browser`, `no_interaction_tools`.
 */
export function resolveCaptureCapability(input: CaptureCapabilityInput): CaptureCapability {
  const reasons: DeliverableReason[] = [];
  if (input.suppressedByFlag !== false) reasons.push('suppressed_by_flag');
  if (input.hasBrowser !== true) reasons.push('no_browser');
  if (input.hasInteractionTools !== true) reasons.push('no_interaction_tools');
  return {
    visionAssist: {
      available: input.vision.available === true && input.vision.reasons.length === 0,
      reasons: [...input.vision.reasons],
    },
    deliverable: { available: reasons.length === 0, reasons },
  };
}

/** The manifest and run-health projection of a capability (snake_case codes). */
export function captureCapabilityRecord(capability: CaptureCapability): CaptureCapabilityRecord {
  return {
    vision_assist: {
      available: capability.visionAssist.available,
      reasons: [...capability.visionAssist.reasons],
    },
    deliverable: {
      available: capability.deliverable.available,
      reasons: [...capability.deliverable.reasons],
    },
  };
}
