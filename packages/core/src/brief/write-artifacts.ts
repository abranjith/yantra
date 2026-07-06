/**
 * Atomic Brief artifact writer (FEAT-015, TASK-005).
 *
 * Persists the three per-run Brief artifacts into the run directory:
 * - `brief.json` — the canonical, schema-valid Brief document.
 * - `brief.md`   — the portable full-detail Markdown ({@link briefToMarkdown}).
 * - `brief.html` — the inert self-contained HTML ({@link briefToHtml}).
 *
 * Each file is written to a `.tmp` sibling and then renamed into place — the
 * same crash-safe convention as `FilesystemCheckpointStore` (rename is atomic
 * on POSIX and same-volume NTFS). Writing is **best-effort**: a failure returns
 * a `Result` error (never throws) so the caller can surface it as a run-level
 * warning while the run still succeeds with terminal output (plan §6). On any
 * failure the `.tmp` files this call created are cleaned up.
 */

import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Brief, Result } from '@yantra/protocol';
import { err, ok } from '@yantra/protocol';

import { briefToHtml } from './to-html.js';
import { briefToMarkdown } from './to-markdown.js';

/** On-disk paths of the persisted Brief artifacts. */
export interface BriefArtifactPaths {
  /** Canonical `brief.json`. */
  readonly jsonPath: string;
  /** Portable `brief.md`. */
  readonly mdPath: string;
  /** Inert `brief.html`. */
  readonly htmlPath: string;
}

/** Raised (as a `Result` error, never thrown) when artifact persistence fails. */
export class BriefArtifactWriteError extends Error {
  public override readonly name = 'BriefArtifactWriteError';

  public constructor(
    message: string,
    public readonly context: {
      /** The run directory the write targeted. */
      readonly runDir: string;
      /** Underlying cause, when available. */
      readonly cause?: unknown;
    },
  ) {
    super(message);
  }
}

/**
 * Writes `brief.json`, `brief.md`, and `brief.html` into `runDir` atomically.
 *
 * @param runDir - The run directory (created if missing).
 * @param brief - A fully-formed, schema-valid Brief.
 * @returns `ok(paths)` on success, or `err(BriefArtifactWriteError)` with the
 *   `.tmp` files cleaned up on any failure.
 *
 * @example
 * const result = await writeBriefArtifacts(runDir, brief);
 * if (!result.isOk) logger.warn({ runDir }, 'brief artifacts not written');
 */
export async function writeBriefArtifacts(
  runDir: string,
  brief: Brief,
): Promise<Result<BriefArtifactPaths, BriefArtifactWriteError>> {
  const targets = [
    { path: join(runDir, 'brief.json'), content: `${JSON.stringify(brief, null, 2)}\n` },
    { path: join(runDir, 'brief.md'), content: `${briefToMarkdown(brief)}\n` },
    { path: join(runDir, 'brief.html'), content: briefToHtml(brief) },
  ] as const;
  const tmpFor = (path: string): string => `${path}.tmp`;

  try {
    await mkdir(runDir, { recursive: true });

    // Stage every artifact to its .tmp sibling first; a failure here leaves no
    // final file visible (renames below never run).
    await Promise.all(
      targets.map((target) => writeFile(tmpFor(target.path), target.content, 'utf8')),
    );

    // Promote the staged files into place.
    await Promise.all(targets.map((target) => rename(tmpFor(target.path), target.path)));

    return ok({
      jsonPath: targets[0].path,
      mdPath: targets[1].path,
      htmlPath: targets[2].path,
    });
  } catch (cause) {
    await Promise.all(targets.map((target) => unlink(tmpFor(target.path)).catch(() => undefined)));
    return err(
      new BriefArtifactWriteError(`failed to write brief artifacts to ${runDir}`, {
        runDir,
        cause,
      }),
    );
  }
}
