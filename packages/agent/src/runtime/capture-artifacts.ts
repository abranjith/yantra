/**
 * One `browser_capture` call's saved files (FEAT-058): the model-visible and
 * Brief projection of a deliverable capture, and its generic artifact
 * references.
 *
 * The files live under the run's `screenshots/` directory and are never sent
 * to the model provider, so every reference carries `sent_to_model: false`.
 */

import type { ArtifactRef, ArtifactScope, CaptureLabel } from '@yantra/protocol';

/** One saved PNG of a capture set. */
export interface CapturePart {
  /** Run-relative path, `screenshots/capture-<seq>-<sha12>[-p<i>].png`. */
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
  /** 1-based position in the set. */
  readonly part: number;
}

/** Everything one `browser_capture` call saved. */
export interface CaptureArtifactSet {
  readonly scope: ArtifactScope;
  /** The captured element's ref (element scope only). */
  readonly ref?: string;
  /** 1 to 6 files, top to bottom. */
  readonly parts: readonly CapturePart[];
  /** False when the set was clipped or truncated. */
  readonly complete: boolean;
  readonly labels: readonly CaptureLabel[];
  /** CSS pixels of height the parts cover (`full_page` and `element`). */
  readonly captured_height?: number;
  /** CSS pixels of height the target has (`full_page` and `element`). */
  readonly page_height?: number;
}

/** The generic artifact references of a capture set, one per file. */
export function artifactRefsOfSet(set: CaptureArtifactSet): ArtifactRef[] {
  return set.parts.map((part) => ({
    kind: 'screenshot' as const,
    path: part.path,
    sha256: part.sha256,
    mime_type: 'image/png' as const,
    bytes: part.bytes,
    width: part.width,
    height: part.height,
    sent_to_model: false,
  }));
}
