/**
 * Atomic templated-report artifact writer.
 *
 * This family is named `document.*`, not `report.*`, because `report.md` is the
 * existing per-run audit/trust report owned by `FilesystemReportBuilder`.
 * Writes stage all three siblings to `.tmp`, rename into place, and clean staged
 * files on any failure.
 */

import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Result, TemplatedReport } from '@yantra/protocol';
import { err, ok } from '@yantra/protocol';

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
  const tmpFor = (path: string): string => `${path}.tmp`;
  try {
    await mkdir(runDir, { recursive: true });
    await Promise.all(
      targets.map((target) => writeFile(tmpFor(target.path), target.content, 'utf8')),
    );
    await Promise.all(targets.map((target) => rename(tmpFor(target.path), target.path)));
    return ok({ jsonPath: targets[0].path, mdPath: targets[1].path, htmlPath: targets[2].path });
  } catch (cause) {
    await Promise.all(targets.map((target) => unlink(tmpFor(target.path)).catch(() => undefined)));
    return err(
      new ReportArtifactWriteError(`failed to write report artifacts to ${runDir}`, {
        runDir,
        cause,
      }),
    );
  }
}
