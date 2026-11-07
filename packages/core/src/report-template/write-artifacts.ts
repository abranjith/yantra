/**
 * Atomic templated-report artifact writer.
 *
 * This family is named `document.*`, not `report.*`, because `report.md` is the
 * existing per-run audit/trust report owned by `FilesystemReportBuilder`.
 * Writes stage all three siblings to `.tmp`, rename into place, and clean staged
 * files on any failure.
 */

import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import type { Result, TemplatedReport } from '@yantra/protocol';
import { err, ok } from '@yantra/protocol';

import { uniqueTempPath } from '../fs/atomic-write.js';

import { templatedReportToHtml } from './to-html.js';

/** On-disk paths of one templated report's `document.*` artifacts. */
export interface ReportArtifactPaths {
  /** Canonical `document.json`. */
  readonly jsonPath: string;
  /** Portable `document.md`. */
  readonly mdPath: string;
  /** Inert `document.html`. */
  readonly htmlPath: string;
}

/** Result error returned when `document.*` persistence fails. */
export class ReportArtifactWriteError extends Error {
  public override readonly name = 'ReportArtifactWriteError';

  /** Create a path-safe write error with its original cause retained. */
  public constructor(
    message: string,
    public readonly context: { readonly runDir: string; readonly cause?: unknown },
  ) {
    super(message, context.cause === undefined ? undefined : { cause: context.cause });
  }
}

/**
 * Write `document.json`, `document.md`, and `document.html` atomically.
 *
 * @param runDir Owning run directory (created if needed).
 * @param report Validated templated report.
 * @returns Artifact paths, or a non-throwing write error after `.tmp` cleanup.
 */
export async function writeReportArtifacts(
  runDir: string,
  report: TemplatedReport,
): Promise<Result<ReportArtifactPaths, ReportArtifactWriteError>> {
  const targets = [
    { path: join(runDir, 'document.json'), content: `${JSON.stringify(report, null, 2)}\n` },
    { path: join(runDir, 'document.md'), content: `${report.rendered_md}\n` },
    { path: join(runDir, 'document.html'), content: templatedReportToHtml(report) },
  ] as const;
  const staged = targets.map((target) => ({ ...target, temporary: uniqueTempPath(target.path) }));
  const owned = new Set<string>();
  try {
    await mkdir(runDir, { recursive: true });
    const writes = await Promise.allSettled(
      staged.map(async (target) => {
        const file = await open(target.temporary, 'wx', 0o600);
        owned.add(target.temporary);
        try {
          await file.writeFile(target.content, 'utf8');
        } finally {
          await file.close();
        }
      }),
    );
    const writeFailure = writes.find((result) => result.status === 'rejected');
    if (writeFailure?.status === 'rejected') throw writeFailure.reason;
    const renames = await Promise.allSettled(
      staged.map((target) => rename(target.temporary, target.path)),
    );
    const renameFailure = renames.find((result) => result.status === 'rejected');
    if (renameFailure?.status === 'rejected') throw renameFailure.reason;
    return ok({ jsonPath: targets[0].path, mdPath: targets[1].path, htmlPath: targets[2].path });
  } catch (cause) {
    await Promise.all([...owned].map((path) => unlink(path).catch(() => undefined)));
    return err(
      new ReportArtifactWriteError(`failed to write report artifacts to ${runDir}`, {
        runDir,
        cause,
      }),
    );
  }
}
