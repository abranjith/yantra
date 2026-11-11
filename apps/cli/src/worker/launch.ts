/**
 * Reading and gating a detached worker's launch file (FEAT-064 TASK-012).
 */

import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

import { workerLaunchRoot } from '@yantra/core';
import {
  WorkerLaunch,
  parseInvocation,
  type CommandResultMessage,
  type ExecutionClass,
} from '@yantra/protocol';

/** Overrides the launch directory a worker accepts; tests only. */
export const WORKER_LAUNCH_DIR_ENV = 'YANTRA_WORKER_LAUNCH_DIR';

/** Execution classes a detached worker may run (plan §6). */
export const WORKER_CLASSES: ReadonlySet<ExecutionClass> = new Set(['run', 'mutate', 'exclusive']);

export type LaunchRead =
  | { readonly ok: true; readonly launch: WorkerLaunch }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** The directory launch files must live in. */
export function acceptedLaunchRoot(env: Readonly<NodeJS.ProcessEnv>): string {
  const override = env[WORKER_LAUNCH_DIR_ENV]?.trim();
  return resolve(override !== undefined && override.length > 0 ? override : workerLaunchRoot());
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Reads and validates a launch file. A path outside the accepted launch
 * directory is refused, so a worker never runs an arbitrary file's invocation.
 */
export async function readWorkerLaunch(
  path: string,
  env: Readonly<NodeJS.ProcessEnv>,
): Promise<LaunchRead> {
  if (!isAbsolute(path)) {
    return {
      ok: false,
      code: 'WORKER_LAUNCH_NOT_ABSOLUTE',
      message: 'The launch path must be absolute.',
    };
  }
  if (!inside(acceptedLaunchRoot(env), resolve(path))) {
    return {
      ok: false,
      code: 'WORKER_LAUNCH_OUTSIDE_ROOT',
      message: 'The launch file is not in the worker launch directory.',
    };
  }
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    return {
      ok: false,
      code: 'WORKER_LAUNCH_UNREADABLE',
      message: `The launch file could not be read: ${(error as NodeJS.ErrnoException).code ?? 'error'}.`,
    };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw) as unknown;
  } catch {
    return { ok: false, code: 'WORKER_LAUNCH_INVALID', message: 'The launch file is not JSON.' };
  }
  const parsed = WorkerLaunch.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      code: 'WORKER_LAUNCH_INVALID',
      message: 'The launch file does not match the worker launch schema.',
    };
  }
  return { ok: true, launch: parsed.data };
}

/**
 * Refuses an invocation whose execution class a worker must not run:
 * `in-process-secure` (secrets), `exemption` (terminal-only), `adapter` and
 * `read`. Returns the error result, or null when the worker may run it.
 */
export function workerClassRefusal(launch: WorkerLaunch): CommandResultMessage | null {
  const { invocation } = launch;
  const parsed = parseInvocation([...invocation.path, ...invocation.argv], {
    cwd: invocation.cwd,
    invocationId: invocation.invocation_id,
  });
  if (!parsed.isOk) {
    return {
      type: 'error',
      exit_code: 1,
      code: parsed.error.code,
      message: parsed.error.message,
      remediation: parsed.error.suggestion ?? null,
    };
  }
  if (WORKER_CLASSES.has(parsed.value.execution)) return null;
  return {
    type: 'error',
    exit_code: 1,
    code: 'WORKER_CLASS_REFUSED',
    message: `${invocation.path.join(' ')} (${parsed.value.execution}) does not run on a worker.`,
    remediation: null,
  };
}
