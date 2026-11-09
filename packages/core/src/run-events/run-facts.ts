/**
 * Builders for the run-level facts every run kind records (FEAT-063):
 * `artifact_saved` and `run_outcome`. Producers share them so each event is
 * built one way.
 */

import { statSync } from 'node:fs';
import { extname, isAbsolute, relative, sep } from 'node:path';

import type { FailureClass, RunEventOf, TaskOutcome, TerminationReason } from '@yantra/protocol';

import { ResourceBusyError } from '../locks/resource-lock.js';

import type { RunEventStream } from './stream.js';

/** What an `artifact_saved` file is. */
export type ArtifactKind = RunEventOf<'artifact_saved'>['artifact_kind'];

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.html': 'text/html',
  '.png': 'image/png',
  '.txt': 'text/plain',
  '.jsonl': 'application/x-ndjson',
};

/**
 * The run-relative POSIX path of a file inside `runDir`, or null when the file
 * is not inside it.
 */
export function runRelativePath(runDir: string, absolutePath: string): string | null {
  const rel = relative(runDir, absolutePath);
  if (rel.length === 0 || isAbsolute(rel) || rel.split(sep).includes('..')) return null;
  return rel.split(sep).join('/');
}

/**
 * Records that the run saved `absolutePath`. The size is read from disk (null
 * when the file cannot be stat'ed); a path outside the run directory is never
 * recorded.
 *
 * @returns Whether an event was emitted.
 */
export function emitArtifactSaved(
  stream: RunEventStream,
  runDir: string,
  absolutePath: string,
  artifactKind: ArtifactKind,
  at: string = new Date().toISOString(),
): boolean {
  const path = runRelativePath(runDir, absolutePath);
  if (path === null) return false;
  let bytes: number | null;
  try {
    bytes = statSync(absolutePath).size;
  } catch {
    // A file that vanished between write and record is still a saved artifact
    // of this run; its size is simply unknown.
    bytes = null;
  }
  stream.emit({
    kind: 'artifact_saved',
    path,
    artifact_kind: artifactKind,
    media_type: MEDIA_TYPES[extname(absolutePath).toLowerCase()] ?? 'application/octet-stream',
    bytes,
    at,
  });
  return true;
}

/** Inputs of a `run_outcome` event. */
export interface RunOutcomeFacts {
  readonly runId: string;
  readonly taskOutcome: TaskOutcome;
  readonly terminationReason: TerminationReason | null;
  readonly stopDetail: string | null;
  readonly exitCode: number;
  readonly failureClass: FailureClass | null;
  readonly at?: string;
}

/** Builds the one `run_outcome` event of a run. */
export function runOutcomeEvent(facts: RunOutcomeFacts): RunEventOf<'run_outcome'> {
  return {
    kind: 'run_outcome',
    run_id: facts.runId,
    task_outcome: facts.taskOutcome,
    termination_reason: facts.terminationReason,
    stop_detail: facts.stopDetail,
    exit_code: facts.exitCode,
    failure_class: facts.failureClass,
    at: facts.at ?? new Date().toISOString(),
  };
}

/**
 * The exit code a run reports when it ended by throwing rather than returning
 * an outcome: 3 for a busy shared resource (an environment failure), else 2
 * (an execution failure).
 */
export function exitCodeForThrown(error: unknown): number {
  return error instanceof ResourceBusyError ? 3 : 2;
}

/**
 * Ends a stream this caller owns after its run threw: records a `failed`
 * outcome unless one was already recorded, then closes the stream. A stream
 * the caller was handed is left alone — its owner records the outcome with
 * the exit code it actually returns.
 */
export function abandonOwnedStream(
  stream: RunEventStream,
  owned: boolean,
  runId: string,
  error: unknown,
): void {
  if (!owned) return;
  if (stream.opened && !stream.outcomeRecorded) {
    try {
      stream.emit(
        runOutcomeEvent({
          runId,
          taskOutcome: 'failed',
          terminationReason: null,
          stopDetail: null,
          exitCode: exitCodeForThrown(error),
          failureClass: 'unexpected',
        }),
      );
    } catch {
      // The log already ends with an outcome (a reopened run): nothing to add.
    }
  }
  stream.close();
}
