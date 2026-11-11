/**
 * `spawnDetachedWorker` — the single cross-OS way the app host starts a
 * detached worker (FEAT-064 TASK-012).
 *
 * 1. The launch file is created exclusively (`wx`, owner-only) in the launch
 *    directory: user text such as a goal travels in it, never in argv.
 * 2. A short-lived trampoline starts the worker detached and reports its PID
 *    (spike S2, RC1), so a process-tree kill of the host cannot reach it.
 * 3. The worker's creation identity is captured for ownership checks.
 *
 * Accepted limitation: a host inside a Windows Job object with
 * `KILL_ON_JOB_CLOSE` and no `SILENT_BREAKAWAY_OK` still takes its workers
 * with it; Node offers no breakaway flag (plan D6).
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { UNKNOWN_START_TOKEN, identifyProcess, type ProcessIdentity } from '@yantra/core';
import type { WorkerLaunch } from '@yantra/protocol';

export interface SpawnDetachedWorkerOptions {
  readonly launch: WorkerLaunch;
  /** Directory the launch file is created in (normally `workerLaunchRoot()`). */
  readonly launchDir: string;
  /** The worker's environment; it inherits the host's (plan D13). */
  readonly env: NodeJS.ProcessEnv;
  readonly nodePath?: string;
  readonly workerPath?: string;
  readonly trampolinePath?: string;
  /** `child_process.spawn` seam (tests). */
  readonly spawn?: typeof nodeSpawn;
  /** Identity seam (tests). */
  readonly identify?: (pid: number) => Promise<ProcessIdentity | null>;
}

export interface SpawnedWorker {
  readonly pid: number;
  readonly identity: ProcessIdentity;
  readonly launchPath: string;
}

/** The worker could not be started; the launch file is left for diagnosis. */
export class WorkerSpawnError extends Error {
  public override readonly name = 'WorkerSpawnError';
}

/** `<launchDir>/<invocation_id>.launch.json` */
export function launchFilePath(launchDir: string, invocationId: string): string {
  return join(launchDir, `${invocationId}.launch.json`);
}

/** `<launchDir>/<invocation_id>.result.json`, beside its launch file. */
export function resultFilePath(launchDir: string, invocationId: string): string {
  return join(launchDir, `${invocationId}.result.json`);
}

/** Starts a detached worker for `launch`; see the module comment. */
export async function spawnDetachedWorker(
  options: SpawnDetachedWorkerOptions,
): Promise<SpawnedWorker> {
  const nodePath = options.nodePath ?? process.execPath;
  const workerPath = options.workerPath ?? fileURLToPath(new URL('../worker.js', import.meta.url));
  const trampolinePath =
    options.trampolinePath ?? fileURLToPath(new URL('./trampoline.js', import.meta.url));
  const spawn = options.spawn ?? nodeSpawn;

  await mkdir(options.launchDir, { recursive: true, mode: 0o700 });
  const launchPath = launchFilePath(options.launchDir, options.launch.invocation.invocation_id);
  // Exclusive: an existing launch file is never overwritten (EEXIST).
  await writeFile(launchPath, `${JSON.stringify(options.launch)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });

  const trampoline = spawn(
    nodePath,
    [trampolinePath, nodePath, workerPath, '--launch', launchPath],
    {
      cwd: options.launch.invocation.cwd,
      env: options.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    },
  );
  const pid = await new Promise<number>((resolve, reject) => {
    let out = '';
    trampoline.stdout?.setEncoding('utf8');
    trampoline.stdout?.on('data', (chunk: string) => {
      out += chunk;
    });
    trampoline.once('error', (error) => {
      reject(new WorkerSpawnError(`The worker trampoline could not start: ${error.message}`));
    });
    trampoline.once('close', (code) => {
      const parsed = Number.parseInt(out.trim(), 10);
      if (code === 0 && Number.isInteger(parsed) && parsed > 0) resolve(parsed);
      else reject(new WorkerSpawnError(`The worker trampoline exited with ${String(code)}.`));
    });
  });
  const identity = (await (options.identify ?? identifyProcess)(pid)) ?? {
    pid,
    startToken: UNKNOWN_START_TOKEN,
  };
  return { pid, identity, launchPath };
}
