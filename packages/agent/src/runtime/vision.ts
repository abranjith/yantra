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

/** The complete registration decision retained for audit and deterministic catalogs. */
export interface VisionAvailability extends VisionAvailabilityInput {
  readonly available: boolean;
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

/** Why Vision Assist is unavailable, as a stable reason code. */
export type VisionUnavailableReason =
  'zero_llm' | 'suppressed_by_flag' | 'no_browser_tools' | 'grant_missing' | 'model_text_only';

/**
 * The first gate that keeps Vision Assist off, in a fixed precedence (the
 * structural gates before the user-owned ones), or null when it is available.
 */
export function visionUnavailableReason(
  vision: VisionAvailability,
): VisionUnavailableReason | null {
  if (vision.available) return null;
  if (vision.zeroLlm) return 'zero_llm';
  if (vision.suppressedByFlag) return 'suppressed_by_flag';
  if (!vision.hasBrowserTools) return 'no_browser_tools';
  if (!vision.grantEnabled) return 'grant_missing';
  return 'model_text_only';
}

/** Computes the five-condition gate. Only literal true inputs can enable capture. */
export function resolveVisionAvailability(input: VisionAvailabilityInput): VisionAvailability {
  const capability: ModelVisionCapability = {
    imageInput: input.modelImageInput === true,
    resolvedAt: 'pre-catalog',
  };
  return {
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
