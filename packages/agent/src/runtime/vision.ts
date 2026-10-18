import type { VisionAssistReason } from '@yantra/protocol';

/** Provider-neutral model capability resolved before the run tool catalog exists. */
export interface ModelVisionCapability {
  readonly imageInput: boolean;
  readonly resolvedAt: 'pre-catalog';
}

/** Inputs to the immutable, fail-closed screenshot registration decision. */
export interface VisionAvailabilityInput {
  readonly grantEnabled: boolean;
  readonly hasBrowserTools: boolean;
  readonly modelImageInput: boolean;
  readonly suppressedByFlag: boolean;
  readonly zeroLlm: boolean;
}

/**
 * A condition that keeps Vision Assist off (FEAT-058 S3), as the manifest and
 * `run-health.json` record it.
 */
export type VisionReason = VisionAssistReason;

/** The complete registration decision retained for audit and deterministic catalogs. */
export interface VisionAvailability extends VisionAvailabilityInput {
  readonly available: boolean;
  /**
   * Every false condition, in a fixed order (`grant_missing`,
   * `model_no_image_input`, `no_browser_tools`, `suppressed_by_flag`,
   * `zero_llm`); empty exactly when {@link available}.
   */
  readonly reasons: readonly VisionReason[];
  readonly capability: ModelVisionCapability;
}

/** Stable metadata for one private PNG artifact; never contains pixel data. */
export interface CaptureMetadata {
  readonly path: string;
  readonly sha256: string;
  readonly mime_type: 'image/png';
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  readonly scope: 'viewport' | 'element';
  readonly ref?: string;
  readonly marks: number;
  readonly seq: number;
}

/** Computes the five-condition gate. Only literal true inputs can enable capture. */
export function resolveVisionAvailability(input: VisionAvailabilityInput): VisionAvailability {
  const capability: ModelVisionCapability = {
    imageInput: input.modelImageInput === true,
    resolvedAt: 'pre-catalog',
  };
  const reasons: VisionReason[] = [];
  if (input.grantEnabled !== true) reasons.push('grant_missing');
  if (!capability.imageInput) reasons.push('model_no_image_input');
  if (input.hasBrowserTools !== true) reasons.push('no_browser_tools');
  if (input.suppressedByFlag === true) reasons.push('suppressed_by_flag');
  if (input.zeroLlm === true) reasons.push('zero_llm');
  return {
    reasons,
    grantEnabled: input.grantEnabled === true,
    hasBrowserTools: input.hasBrowserTools === true,
    modelImageInput: capability.imageInput,
    suppressedByFlag: input.suppressedByFlag === true,
    zeroLlm: input.zeroLlm === true,
    available:
      input.grantEnabled === true &&
      input.hasBrowserTools === true &&
      capability.imageInput &&
      input.suppressedByFlag !== true &&
      input.zeroLlm !== true,
    capability,
  };
}
