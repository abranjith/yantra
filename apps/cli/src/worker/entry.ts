/**
 * The detached worker (FEAT-064 TASK-012): runs one launch file's invocation
 * through the FEAT-072 worker adapter and writes its `WorkerResult` once.
 */

import { basename, dirname, join } from 'node:path';

import type { CommandResultMessage, WorkerLaunch } from '@yantra/protocol';

import type { WorkerChannel } from '../adapters/worker/channel.js';
import { runWorkerInvocation, type WorkerRunOptions } from '../adapters/worker/worker-adapter.js';

import { readWorkerLaunch, workerClassRefusal } from './launch.js';
import { WorkerResultSink } from './result-sink.js';

/**
 * Decides, before any side effect, whether this worker may run its launch.
 * FEAT-065 supplies the invocation claim (D11); refusing exits 0 and writes
 * nothing, because another worker owns the invocation.
 */
export type WorkerStartGate = (launch: WorkerLaunch) => Promise<boolean>;

export interface WorkerDeps {
  /** The worker's environment (the host's, plan D13). */
  readonly env: Readonly<NodeJS.ProcessEnv>;
  /** Changes the process working directory; only the process entry owns it. */
  readonly chdir: (path: string) => void;
  readonly gate?: WorkerStartGate;
  readonly run?: typeof runWorkerInvocation;
  readonly runOptions?: WorkerRunOptions;
}

/**
 * A worker with no one attached: prompts answer "no", confirmations are
 * denied, and cancellation arrives through the run socket instead.
 */
export class UnattendedChannel implements WorkerChannel {
  public attended(): boolean {
    return false;
  }
  public diagnostic(): void {
    // No terminal: diagnostics live in the run's own logs.
  }
  public event(): void {
    // Events reach clients through the run socket and run-events.jsonl.
  }
  public requestConfirmation(): Promise<'granted' | 'denied'> {
    return Promise.resolve('denied');
  }
  public requestInstallOffer(): Promise<boolean> {
    return Promise.resolve(false);
  }
  public requestInput(): Promise<string | boolean | null> {
    return Promise.resolve(null);
  }
  public onCancel(): () => void {
    return () => undefined;
  }
  public complete(): void {
    // The result is written by the worker entry.
  }
}

/** `<id>.launch.json` → `<id>.result.json`, for a launch file too broken to name one. */
function conventionalResultPath(launchPath: string): string | null {
  const name = basename(launchPath);
  if (!name.endsWith('.launch.json')) return null;
  return join(dirname(launchPath), `${name.slice(0, -'.launch.json'.length)}.result.json`);
}

function invocationIdOf(launchPath: string): string {
  return basename(launchPath).replace(/\.launch\.json$/u, '');
}

/**
 * Runs the worker for `argv` (exactly `--launch <abs path>`) and returns its
 * exit code. Never throws: an uncaught failure becomes an `error` result
 * (exit 2).
 */
export async function runWorker(argv: readonly string[], deps: WorkerDeps): Promise<number> {
  const { env } = deps;
  const [flag, launchPath, ...extra] = argv;
  if (flag !== '--launch' || launchPath === undefined || extra.length > 0) return 1;

  const read = await readWorkerLaunch(launchPath, env);
  if (!read.ok) {
    // Only a launch file inside the launch directory gets a result beside it;
    // a path elsewhere must never make the worker write there.
    const fallback =
      read.code === 'WORKER_LAUNCH_OUTSIDE_ROOT' || read.code === 'WORKER_LAUNCH_NOT_ABSOLUTE'
        ? null
        : conventionalResultPath(launchPath);
    if (fallback !== null) {
      await new WorkerResultSink(fallback, { invocationId: invocationIdOf(launchPath) })
        .write({
          type: 'error',
          exit_code: 1,
          code: read.code,
          message: read.message,
          remediation: null,
        })
        .catch(() => false);
    }
    return 1;
  }
  const { launch } = read;
  const sink = new WorkerResultSink(launch.result_path, {
    invocationId: launch.invocation.invocation_id,
    ...(launch.run_id === undefined ? {} : { runId: launch.run_id }),
  });
  const finish = async (outcome: CommandResultMessage): Promise<number> => {
    await sink.write(outcome);
    return outcome.exit_code;
  };

  try {
    const refusal = workerClassRefusal(launch);
    if (refusal !== null) return await finish(refusal);
    if (deps.gate !== undefined && !(await deps.gate(launch))) return 0;
    deps.chdir(launch.invocation.cwd);
    const outcome = await (deps.run ?? runWorkerInvocation)(
      launch.invocation,
      new UnattendedChannel(),
      env,
      deps.runOptions ?? {},
    );
    return await finish(outcome);
  } catch (error) {
    return finish({
      type: 'error',
      exit_code: 2,
      code: 'WORKER_FAILED',
      message: error instanceof Error ? error.message : String(error),
      remediation: null,
    }).catch(() => 2);
  }
}
