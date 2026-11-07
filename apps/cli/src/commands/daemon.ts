/**
 * `yantra daemon {start|stop|status}` — manage the local scheduler service
 * (FEAT-021 TASK-002).
 *
 *   yantra daemon start [--foreground]   run the scheduler (detached by default)
 *   yantra daemon stop                   signal the running daemon to shut down
 *   yantra daemon status [--json]        report running?, pid, schedules, next fires
 *
 * `start` without `--foreground` spawns a detached copy of this process running
 * `daemon start --foreground`, so the shell returns immediately; the child holds
 * the single-instance lock. `stop` signals the lock-holder PID and waits for it
 * to release. There is no OS service registration in this feature (documented as
 * a TODO for launchd/systemd/Task Scheduler units).
 *
 * @example
 *   yantra daemon start
 *   yantra daemon status --json
 *   yantra daemon stop
 */

import { setTimeout as delay } from 'node:timers/promises';

import { FileDaemonLock, type DaemonLock, type SchedulerDaemon, type Logger } from '@yantra/core';
import { type Command } from 'commander';

import { createTerminalContext } from '../adapters/terminal/terminal-adapter.js';
import type { CommandContext, CommandResult, ExitCode } from '../context/command-context.js';
import { createRegisteredCommand } from '../registry/build-command-tree.js';
import { fromAction } from '../registry/handler.js';
import { makeStderrLogger } from '../runtime.js';
import { openScheduleStore } from '../schedule-store.js';

import { buildDaemon } from './daemon-runtime.js';

interface DaemonStartOptions {
  readonly foreground?: boolean;
  readonly debug?: boolean;
}

interface DaemonStopOptions {
  readonly debug?: boolean;
}

interface DaemonStatusOptions {
  readonly json?: boolean;
  readonly debug?: boolean;
}

export function makeDaemonCommand(): Command {
  return createRegisteredCommand('daemon', daemonHandlers());
}

export interface DaemonRuntime {
  readonly build?: (
    logger: Logger,
    cwd: string,
  ) => Promise<{
    readonly daemon: Pick<SchedulerDaemon, 'start' | 'stop' | 'status'>;
    readonly close: () => void;
  } | null>;
  readonly lock?: DaemonLock;
}
export function daemonHandlers(
  runtime: DaemonRuntime = {},
  context: CommandContext = createTerminalContext(),
) {
  return {
    'daemon.start': Object.assign(
      fromAction((options: DaemonStartOptions) =>
        options.foreground === true
          ? runForeground(context, runtime, options.debug === true)
          : spawnDetached(context, runtime),
      ),
      { honorsAbort: true },
    ),
    'daemon.stop': fromAction((options: DaemonStopOptions) =>
      stopDaemon(context, runtime, options.debug === true),
    ),
    'daemon.status': fromAction((options: DaemonStatusOptions) =>
      reportStatus(context, runtime, options.json === true, options.debug === true),
    ),
  };
}
async function assemble(context: CommandContext, runtime: DaemonRuntime, logger: Logger) {
  return runtime.build
    ? runtime.build(logger, context.cwd)
    : buildDaemon(logger, undefined, { cwd: context.cwd });
}

/** Runs the daemon in the foreground, blocking until SIGTERM/SIGINT. */
async function runForeground(
  context: CommandContext,
  runtime: DaemonRuntime,
  debug: boolean,
): Promise<CommandResult> {
  const logger = makeStderrLogger(debug, context.output.stderr);
  const built = await assemble(context, runtime, logger);
  if (!built) {
    context.output.stderr.write(
      'Error: the local index is unavailable \u2014 cannot start the daemon.\n',
    );
    return { exitCode: 3 };
  }
  try {
    try {
      await built.daemon.start();
    } catch (error) {
      context.output.stderr.write(
        `Error: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return { exitCode: 1 };
    }
    context.output.stdout.write(
      `Scheduler daemon running (pid ${context.processes.pid}). Press Ctrl+C to stop.\n`,
    );
    await new Promise<void>((resolve) => {
      if (context.signal.aborted) resolve();
      else context.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    const reason = typeof context.signal.reason === 'string' ? context.signal.reason : 'SIGINT';
    context.output.stderr.write(`\nReceived ${reason}, shutting down...\n`);
    await built.daemon
      .stop()
      .catch((error) =>
        logger.warn(
          { error: error instanceof Error ? error.message : String(error) },
          'daemon shutdown failed',
        ),
      );
    return { exitCode: 0 };
  } finally {
    built.close();
  }
}

/** Spawns a detached `daemon start --foreground` child, then returns. */
async function spawnDetached(
  context: CommandContext,
  runtime: DaemonRuntime,
): Promise<CommandResult> {
  // Refuse to spawn a second instance if one is already running.
  const lock = runtime.lock ?? new FileDaemonLock();
  const info = await lock.probe();
  if (info !== null) {
    context.output.stderr.write(
      `The scheduler daemon is already running${info.pid !== null ? ` (pid ${info.pid})` : ''}.\n`,
    );
    return { exitCode: 1 as ExitCode };
  }

  const pid = await context.processes.spawnDaemon();
  context.output.stdout.write(`Scheduler daemon started (pid ${pid}).\n`);
  return { exitCode: 0 };
}

/** Signals the lock-holder PID and waits (bounded) for the lock to free. */
async function stopDaemon(
  context: CommandContext,
  runtime: DaemonRuntime,
  debug: boolean,
): Promise<CommandResult> {
  const logger = makeStderrLogger(debug, context.output.stderr);
  const lock = runtime.lock ?? new FileDaemonLock();
  const info = await lock.probe();
  if (info?.pid == null) {
    context.output.stderr.write('The scheduler daemon is not running.\n');
    return { exitCode: 0 as ExitCode };
  }

  try {
    await context.processes.signalDaemon(info);
  } catch (err) {
    logger.warn(
      { pid: info.pid, err: err instanceof Error ? err.message : String(err) },
      'failed to signal daemon',
    );
    context.output.stderr.write(
      `Could not signal daemon pid ${info.pid} (it may have already exited).\n`,
    );
    return { exitCode: 0 as ExitCode };
  }

  // Wait up to ~10s for the process to release the lock.
  for (let i = 0; i < 50; i++) {
    await delay(200);
    const still = await lock.probe();
    if (still === null) {
      context.output.stdout.write(`Scheduler daemon (pid ${info.pid}) stopped.\n`);
      return { exitCode: 0 as ExitCode };
    }
  }
  context.output.stderr.write(
    `Signaled daemon pid ${info.pid}, but it has not released the lock yet.\n`,
  );
  return { exitCode: 0 as ExitCode };
}

/** Prints the daemon status (running?, pid, schedules, next fires). */
async function reportStatus(
  context: CommandContext,
  runtime: DaemonRuntime,
  json: boolean,
  debug: boolean,
): Promise<CommandResult> {
  const logger = makeStderrLogger(debug, context.output.stderr);
  const built = await assemble(context, runtime, logger);
  if (built === null) {
    const empty = {
      running: false,
      pid: null,
      schedulesLoaded: 0,
      nextFires: [],
      pendingConfirmations: 0,
    };
    if (json) {
      context.output.json(empty, { indent: 2 });
    } else {
      context.output.stdout.write('Scheduler daemon: not running (index unavailable).\n');
    }
    return { exitCode: 0 as ExitCode };
  }

  try {
    const status = await built.daemon.status();
    if (json) {
      context.output.json(status, { indent: 2 });
      return { exitCode: 0 as ExitCode };
    }
    const lines: string[] = [];
    lines.push(`Scheduler daemon: ${status.running ? 'running' : 'stopped'}`);
    if (status.pid !== null) lines.push(`  pid:                   ${status.pid}`);
    lines.push(`  schedules loaded:      ${status.schedulesLoaded}`);
    lines.push(`  pending confirmations: ${status.pendingConfirmations}`);
    for (const nf of status.nextFires) {
      lines.push(`  next fire ${nf.id}: ${nf.nextFireAt ?? '—'}`);
    }
    context.output.stdout.write(lines.join('\n') + '\n');
    return { exitCode: 0 as ExitCode };
  } finally {
    built.close();
  }
}

// `openScheduleStore` is imported so status/stop share the same index-open path
// used elsewhere; buildDaemon uses it internally. Re-exported for tests.
export { openScheduleStore };
