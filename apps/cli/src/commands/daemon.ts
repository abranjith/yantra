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

import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

import { FileDaemonLock } from '@yantra/core';
import { Command } from 'commander';

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
  const cmd = new Command('daemon');
  cmd.description('Manage the local scheduler service');

  cmd
    .command('start')
    .description('Start the scheduler daemon')
    .option('--foreground', 'Run in the foreground instead of detaching', false)
    .option('--debug', 'Verbose logging to stderr', false)
    .action(async (options: DaemonStartOptions) => {
      if (options.foreground === true) {
        await runForeground(options.debug === true);
        return;
      }
      await spawnDetached();
    });

  cmd
    .command('stop')
    .description('Stop the running scheduler daemon')
    .option('--debug', 'Verbose logging to stderr', false)
    .action(async (options: DaemonStopOptions) => {
      await stopDaemon(options.debug === true);
    });

  cmd
    .command('status')
    .description('Report scheduler daemon status')
    .option('--json', 'Emit JSON status to stdout', false)
    .option('--debug', 'Verbose logging to stderr', false)
    .action(async (options: DaemonStatusOptions) => {
      await reportStatus(options.json === true, options.debug === true);
    });

  return cmd;
}

/** Runs the daemon in the foreground, blocking until SIGTERM/SIGINT. */
async function runForeground(debug: boolean): Promise<void> {
  const logger = makeStderrLogger(debug);
  const built = await buildDaemon(logger);
  if (built === null) {
    process.stderr.write('Error: the local index is unavailable — cannot start the daemon.\n');
    process.exit(3);
    return;
  }
  const { daemon, close } = built;

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`\nReceived ${signal}, shutting down...\n`);
    void daemon
      .stop()
      .catch(() => undefined)
      .finally(() => {
        close();
        process.exit(0);
      });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  try {
    await daemon.start();
  } catch (err) {
    close();
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
    return;
  }

  process.stdout.write(`Scheduler daemon running (pid ${process.pid}). Press Ctrl+C to stop.\n`);
  // Keep the process alive; the interval + signal handlers do the work.
  await new Promise<never>(() => {
    /* never resolves — until a signal calls process.exit */
  });
}

/** Spawns a detached `daemon start --foreground` child, then returns. */
async function spawnDetached(): Promise<void> {
  // Refuse to spawn a second instance if one is already running.
  const lock = new FileDaemonLock();
  const info = await lock.probe();
  if (info !== null) {
    process.stderr.write(
      `The scheduler daemon is already running${info.pid !== null ? ` (pid ${info.pid})` : ''}.\n`,
    );
    process.exit(1);
    return;
  }

  const child = spawn(process.execPath, [process.argv[1]!, 'daemon', 'start', '--foreground'], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  process.stdout.write(`Scheduler daemon started (pid ${child.pid}).\n`);
  process.exit(0);
}

/** Signals the lock-holder PID and waits (bounded) for the lock to free. */
async function stopDaemon(debug: boolean): Promise<void> {
  const logger = makeStderrLogger(debug);
  const lock = new FileDaemonLock();
  const info = await lock.probe();
  if (info?.pid == null) {
    process.stderr.write('The scheduler daemon is not running.\n');
    process.exit(0);
    return;
  }

  try {
    process.kill(info.pid, 'SIGTERM');
  } catch (err) {
    logger.warn(
      { pid: info.pid, err: err instanceof Error ? err.message : String(err) },
      'failed to signal daemon',
    );
    process.stderr.write(`Could not signal daemon pid ${info.pid} (it may have already exited).\n`);
    process.exit(0);
    return;
  }

  // Wait up to ~10s for the process to release the lock.
  for (let i = 0; i < 50; i++) {
    await delay(200);
    const still = await lock.probe();
    if (still === null) {
      process.stdout.write(`Scheduler daemon (pid ${info.pid}) stopped.\n`);
      process.exit(0);
      return;
    }
  }
  process.stderr.write(`Signaled daemon pid ${info.pid}, but it has not released the lock yet.\n`);
  process.exit(0);
}

/** Prints the daemon status (running?, pid, schedules, next fires). */
async function reportStatus(json: boolean, debug: boolean): Promise<void> {
  const logger = makeStderrLogger(debug);
  const built = await buildDaemon(logger);
  if (built === null) {
    const empty = {
      running: false,
      pid: null,
      schedulesLoaded: 0,
      nextFires: [],
      pendingConfirmations: 0,
    };
    if (json) {
      process.stdout.write(`${JSON.stringify(empty, null, 2)}\n`);
    } else {
      process.stdout.write('Scheduler daemon: not running (index unavailable).\n');
    }
    process.exit(0);
    return;
  }

  try {
    const status = await built.daemon.status();
    if (json) {
      process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
      process.exit(0);
      return;
    }
    const lines: string[] = [];
    lines.push(`Scheduler daemon: ${status.running ? 'running' : 'stopped'}`);
    if (status.pid !== null) lines.push(`  pid:                   ${status.pid}`);
    lines.push(`  schedules loaded:      ${status.schedulesLoaded}`);
    lines.push(`  pending confirmations: ${status.pendingConfirmations}`);
    for (const nf of status.nextFires) {
      lines.push(`  next fire ${nf.id}: ${nf.nextFireAt ?? '—'}`);
    }
    process.stdout.write(lines.join('\n') + '\n');
    process.exit(0);
  } finally {
    built.close();
  }
}

// `openScheduleStore` is imported so status/stop share the same index-open path
// used elsewhere; buildDaemon uses it internally. Re-exported for tests.
export { openScheduleStore };
