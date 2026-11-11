/**
 * `yantra ui [--print] [--json]` (FEAT-065 TASK-005/006).
 *
 * 1. Probe `host.lock`. A live, ready host is reused.
 * 2. Otherwise start `dist/ui-host.js` detached (shell-free, explicit argv,
 *    no stdio, the CLI's environment, the data directory as cwd) and wait up
 *    to 10 s for `ready`.
 * 3. Ask the host's control socket for a single-use launch code and build
 *    `http://127.0.0.1:<port>/#code=<code>`.
 * 4. `--print` prints the URL; otherwise the URL opens in a Chrome or Edge
 *    `--app` window. `--json` emits {@link UiOpenResult} either way.
 *
 * Exit 3 (environment) for an unverifiable lock, a host that does not become
 * ready, a bind failure, missing assets or no Chromium browser; each says one
 * next step. The handler never exits the process or writes stdout directly.
 */

import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  FileHostLock,
  dataDir,
  hostLogPath,
  uiRoot,
  yantraVersion,
  type HostLockProbe,
} from '@yantra/core';
import { UiOpenResult, type HostLockRecord } from '@yantra/protocol';

import { createTerminalContext } from '../adapters/terminal/terminal-adapter.js';
import type { CommandContext, CommandResult } from '../context/command-context.js';
import { handler } from '../registry/handler.js';
import { ControlClient } from '../ui/host/control-socket.js';
import { readStartFailure, type HostStartFailure } from '../ui/host/host-runtime.js';
import { openAppWindow, type WindowOpenResult } from '../ui/window-launcher.js';

/** How long `yantra ui` waits for a host to become ready. */
export const HOST_READY_TIMEOUT_MS = 10_000;
const POLL_MS = 100;

/** A host process this invocation started. */
export interface SpawnedHost {
  readonly pid: number;
  /** True once the process has exited. */
  exited(): boolean;
  /** Stops tracking the process so this CLI can exit while it runs on. */
  detach(): void;
}

/** A control-socket client able to issue a launch code. */
export interface LaunchCodeSource {
  issueLaunchCode(): Promise<{ readonly code: string }>;
  close(): void;
}

export interface UiCommandDeps {
  readonly probe: () => Promise<HostLockProbe>;
  readonly spawnHost: () => Promise<SpawnedHost>;
  readonly connectControl: (address: string, token: string) => Promise<LaunchCodeSource>;
  readonly openWindow: (url: string) => Promise<WindowOpenResult>;
  readonly readStartFailure: (pid: number) => Promise<HostStartFailure | null>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  readonly yantraVersion: string;
  readonly readyTimeoutMs?: number;
}

interface UiOptions {
  readonly print?: boolean;
  readonly json?: boolean;
}

/** A failure `yantra ui` reports with exit 3. */
class UiEnvironmentError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly remediation: string,
  ) {
    super(message);
  }
}

/** Starts `dist/ui-host.js` detached, exactly as the terminal would. */
export async function spawnHostProcess(
  env: Readonly<NodeJS.ProcessEnv>,
  hostEntry = fileURLToPath(new URL('../ui-host.js', import.meta.url)),
  spawnProcess: typeof spawn = spawn,
): Promise<SpawnedHost> {
  await mkdir(uiRoot(), { recursive: true, mode: 0o700 });
  const child = spawnProcess(process.execPath, [hostEntry], {
    cwd: dataDir(),
    env: { ...env },
    detached: true,
    shell: false,
    stdio: 'ignore',
    windowsHide: true,
  });
  let exited = false;
  child.once('exit', () => {
    exited = true;
  });
  child.once('error', () => {
    exited = true;
  });
  const pid = child.pid;
  if (pid === undefined) {
    throw new UiEnvironmentError(
      'host_spawn_failed',
      'The app host process could not be started.',
      `Check that Node can run ${hostEntry}, then run \`yantra ui\` again.`,
    );
  }
  return {
    pid,
    exited: () => exited,
    detach: () => {
      child.unref();
    },
  };
}

/** The production dependencies; the host inherits `env` (the CLI's environment, D13). */
export function defaultUiDeps(env: Readonly<NodeJS.ProcessEnv>): UiCommandDeps {
  const lock = new FileHostLock();
  return {
    probe: () => lock.probe(),
    spawnHost: () => spawnHostProcess(env),
    connectControl: (address, token) => ControlClient.connect(address, token),
    openWindow: (url) => openAppWindow(url),
    readStartFailure,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
    yantraVersion: yantraVersion(),
  };
}

/** Finds a live, ready host, starting one when there is none. */
async function ensureHost(
  deps: UiCommandDeps,
): Promise<{ readonly record: HostLockRecord; readonly reused: boolean }> {
  const deadline = deps.now() + (deps.readyTimeoutMs ?? HOST_READY_TIMEOUT_MS);
  let spawned: SpawnedHost | null = null;
  try {
    for (;;) {
      const probe = await deps.probe();
      if (probe.verdict === 'alive' && probe.record.state === 'ready') {
        return {
          record: probe.record,
          reused: spawned?.pid !== probe.record.pid,
        };
      }
      if (probe.verdict === 'unknown' || probe.verdict === 'corrupt') {
        throw new UiEnvironmentError(
          'host_lock_unverifiable',
          probe.verdict === 'unknown'
            ? `An app host (pid ${probe.record.pid}) holds the lock, but whether it is still running cannot be verified.`
            : 'The app host lock cannot be read.',
          'Close any running Yantra app; if none is running, delete the host.lock file in the data directory’s ui folder and run `yantra ui` again.',
        );
      }
      if (probe.verdict !== 'alive') {
        if (spawned === null) {
          spawned = await deps.spawnHost();
        } else if (spawned.exited()) {
          const failure = await deps.readStartFailure(spawned.pid);
          if (failure !== null && failure.code !== 'lock_held') {
            throw new UiEnvironmentError(failure.code, failure.message, failure.remediation);
          }
          if (failure === null) {
            throw new UiEnvironmentError(
              'host_exited',
              'The app host exited before it became ready.',
              `See ${hostLogPath()} for why.`,
            );
          }
        }
      }
      if (deps.now() >= deadline) {
        throw new UiEnvironmentError(
          'host_not_ready',
          `The app host did not become ready within ${Math.round((deps.readyTimeoutMs ?? HOST_READY_TIMEOUT_MS) / 1000)} s.`,
          `See ${hostLogPath()} for why.`,
        );
      }
      await deps.sleep(POLL_MS);
    }
  } finally {
    spawned?.detach();
  }
}

/** Runs `yantra ui` against `deps`; returns the exit result. */
export async function runUi(
  options: UiOptions,
  context: CommandContext,
  deps: UiCommandDeps,
): Promise<CommandResult> {
  const fail = (error: UiEnvironmentError): CommandResult => {
    context.output.stderr.write(`${error.message} ${error.remediation}\n`);
    return {
      exitCode: 3,
      failure: { code: error.code, message: error.message, remediation: error.remediation },
    };
  };

  let host: { readonly record: HostLockRecord; readonly reused: boolean };
  let url: string;
  try {
    host = await ensureHost(deps);
    const { port, control_socket: controlSocket, control_token: token } = host.record;
    if (port === null || controlSocket === null) {
      throw new UiEnvironmentError(
        'host_not_ready',
        'The app host is not ready.',
        `See ${hostLogPath()}.`,
      );
    }
    const control = await deps.connectControl(controlSocket, token).catch((error: unknown) => {
      throw new UiEnvironmentError(
        'host_unreachable',
        error instanceof Error ? error.message : 'The app host is unreachable.',
        `See ${hostLogPath()} for why.`,
      );
    });
    try {
      const { code } = await control.issueLaunchCode();
      url = `http://127.0.0.1:${port}/#code=${code}`;
    } finally {
      control.close();
    }
  } catch (error) {
    if (error instanceof UiEnvironmentError) return fail(error);
    throw error;
  }

  const record = host.record;
  if (host.reused && record.yantra_version !== deps.yantraVersion && options.json !== true) {
    context.output.stderr.write(
      `The running app is Yantra ${record.yantra_version}; close the app and run \`yantra ui\` to use ${deps.yantraVersion}.\n`,
    );
  }
  const result = UiOpenResult.parse({
    schemaVersion: 1,
    url,
    port: record.port,
    hostPid: record.pid,
    reused: host.reused,
  });

  if (options.print === true) {
    if (options.json === true) context.output.json(result, { indent: 2 });
    else context.output.stdout.write(`${url}\n`);
    return { exitCode: 0 };
  }

  const opened = await deps.openWindow(url);
  if (!opened.opened) {
    // D10: the URL is still printed, so the app can be opened by hand.
    if (options.json === true) context.output.json(result, { indent: 2 });
    else context.output.stdout.write(`${url}\n`);
    return fail(new UiEnvironmentError('no_browser', opened.message, opened.remediation));
  }
  if (options.json === true) context.output.json(result, { indent: 2 });
  else context.output.stdout.write(`Opened the Yantra app in ${opened.browser}.\n`);
  return { exitCode: 0 };
}

/** Handler for `ui`, bound by registry id. */
export function uiHandlers(
  context: CommandContext = createTerminalContext(),
  deps: () => UiCommandDeps = () => defaultUiDeps(context.settings.env()),
) {
  return {
    ui: handler<UiOptions>((_args, options) => runUi(options, context, deps())),
  };
}
