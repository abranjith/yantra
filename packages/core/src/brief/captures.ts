/**
 * The wording of a Brief's saved captures (FEAT-058 S11), shared by the
 * Markdown, HTML, and terminal renderers so the three never disagree.
 *
 * ASCII punctuation only. A capture's path is engine-produced and checked
 * against the capture-file grammar before any renderer links it.
 */

import { SCREENSHOT_ARTIFACT_PATH_PATTERN, type BriefArtifact } from '@yantra/protocol';

const SCOPE_WORDS: Readonly<Record<BriefArtifact['scope'], string>> = {
  viewport: 'viewport',
  full_page: 'full-page',
  element: 'element',
};

/** The link text: `full-page screenshot, part 2 of 3`, or `viewport screenshot` for one file. */
export function captureTitle(artifact: BriefArtifact): string {
  const scope = `${SCOPE_WORDS[artifact.scope]} screenshot`;
  return artifact.parts > 1 ? `${scope}, part ${artifact.part} of ${artifact.parts}` : scope;
}

/**
 * The trailing labels: `(incomplete: truncated)` for a clipped or truncated
 * set, and `(below the visible area)` for an element outside the viewport.
 * Empty when the capture is a plain picture of its target.
 */
export function captureLabels(artifact: BriefArtifact): string {
  const incomplete = artifact.labels.filter((label) => label !== 'beyond_viewport');
  const parts: string[] = [];
  if (!artifact.complete || incomplete.length > 0) {
    parts.push(`(incomplete: ${incomplete.length > 0 ? incomplete.join(', ') : 'partial'})`);
  }
  if (artifact.labels.includes('beyond_viewport')) parts.push('(below the visible area)');
  return parts.join(' ');
}

/** True only for an engine-produced capture path, the one relative link a Brief may carry. */
export function isCaptureArtifactPath(path: unknown): path is string {
  return typeof path === 'string' && SCREENSHOT_ARTIFACT_PATH_PATTERN.test(path);
}
