import { z } from 'zod';

import type { ToolAuditEntry } from './tool-audit.js';

/**
 * The generic artifact reference (FEAT-058 S9): one file a tool call wrote to
 * the run directory, cited by `tool-calls.jsonl`, the Brief, and `do --json`.
 *
 * Every capture tool writes it: Vision Assist (`browser_screenshot`) with
 * `sent_to_model: true`, and the local deliverable capture (`browser_capture`)
 * with `sent_to_model: false`, so `yantra audit` can say truthfully which
 * images the model saw. Runs written before it existed carry the older
 * `captures` projection instead; {@link artifactRefsOf} reads both.
 */

/**
 * The capture-file grammar: `screenshots/<seq>-<sha12>.png` (Vision Assist) or
 * `screenshots/capture-<seq>-<sha12>[-p<i>].png` (deliverable capture).
 */
export const SCREENSHOT_ARTIFACT_PATH_PATTERN =
  /^screenshots\/(?:capture-)?\d+-[a-f0-9]{12}(?:-p\d+)?\.png$/;

/** True when `value` is a relative path that cannot leave the run directory. */
function containedByRunDirectory(value: string): boolean {
  return (
    !value.startsWith('/') &&
    !value.startsWith('\\') &&
    !/^[A-Za-z]:[\\/]/.test(value) &&
    !value.includes('\\') &&
    !value.split('/').includes('..')
  );
}

/** A run-relative, forward-slash capture path that matches the capture-file grammar. */
export const ScreenshotArtifactPath = z
  .string()
  .min(1)
  .refine(
    containedByRunDirectory,
    'Artifact path must be a forward-slash relative path contained by the run directory.',
  )
  .refine(
    (value) => SCREENSHOT_ARTIFACT_PATH_PATTERN.test(value),
    'Screenshot artifact path must match screenshots/[capture-]<seq>-<sha12>[-p<i>].png.',
  )
  .describe('Run-relative path of the artifact file, using forward slashes.');

/** The artifact kinds a reference may name; FEAT-060 extends the set. */
export const ArtifactKind = z.enum(['screenshot']).describe('What kind of file the artifact is.');

export type ArtifactKind = z.infer<typeof ArtifactKind>;

const Sha256 = z
  .string()
  .regex(/^[a-f0-9]{64}$/u)
  .describe('Lowercase hex SHA-256 of the file bytes.');

export const ArtifactRef = z
  .object({
    kind: ArtifactKind,
    path: ScreenshotArtifactPath,
    sha256: Sha256,
    mime_type: z.literal('image/png').describe('Media type of the file.'),
    bytes: z.number().int().nonnegative().describe('File size in bytes.'),
    width: z.number().int().positive().optional().describe('Image width in pixels.'),
    height: z.number().int().positive().optional().describe('Image height in pixels.'),
    sent_to_model: z
      .boolean()
      .describe(
        'True only when the image was shown to the model provider (Vision Assist); false for a capture kept on this computer.',
      ),
  })
  .strict()
  .describe(
    'One file a tool call wrote to the run directory: metadata only, never image bytes or a data URI.',
  );

export type ArtifactRef = z.infer<typeof ArtifactRef>;

/**
 * Every artifact a `tool-calls.jsonl` entry cites. New runs carry
 * `artifacts`; a run written before FEAT-058 carries `captures`, each of
 * which can only have been a Vision Assist image, so it reads back as a
 * screenshot with `sent_to_model: true`. The one normalizer every reader
 * uses.
 *
 * @param entry One parsed tool-audit entry.
 * @returns The entry's artifact references, in recorded order.
 */
export function artifactRefsOf(
  entry: Pick<ToolAuditEntry, 'artifacts' | 'captures'>,
): ArtifactRef[] {
  if (entry.artifacts !== undefined) return [...entry.artifacts];
  return (entry.captures ?? []).map((capture) => ({
    kind: 'screenshot' as const,
    path: capture.path,
    sha256: capture.sha256,
    mime_type: capture.mime_type,
    bytes: capture.bytes,
    width: capture.width,
    height: capture.height,
    sent_to_model: true,
  }));
}
