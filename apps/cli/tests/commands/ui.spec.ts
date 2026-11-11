// @no-llm
/**
 * `yantra ui` (FEAT-065 TASK-005/006): host start or reuse, launch codes,
 * `--print`/`--json`, the exit-3 paths and the spawn shape. Hosts run
 * in-process through the real runtime, lock, control socket and sessions.
 */

import type { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import {
  FileHostLock,
  dataDir,
  resetPathCache,
  type LivenessVerdict,
  type ProcessIdentity,
  type ProcessLivenessProbe,
} from '@yantra/core';
import { UiOpenResult } from '@yantra/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTerminalContext } from '../../src/adapters/terminal/terminal-adapter.js';
import {
  runUi,
  spawnHostProcess,
  uiHandlers,
  type SpawnedHost,
  type UiCommandDeps,
} from '../../src/commands/ui.js';
import type { CommandContext } from '../../src/context/command-context.js';
import { ControlClient } from '../../src/ui/host/control-socket.js';
import { HostStartError } from '../../src/ui/host/errors.js';
import {
  startHostRuntime,
  type HostStartFailure,
  type RunningHost,
} from '../../src/ui/host/host-runtime.js';
import type { WindowOpenResult } from '../../src/ui/window-launcher.js';
import { cleanupTempDirs, makeWebBuild } from '../ui/host/support.js';

/** Answers from a table keyed by `pid:startToken`, default `dead`. */
class TableProbe implements ProcessLivenessProbe {
  public readonly table = new Map<string, LivenessVerdict>();
  public set(identity: ProcessIdentity, verdict: LivenessVerdict): void {
    this.table.set(`${identity.pid}:${identity.startToken}`, verdict);
  }
  public identify(pid: number): Promise<ProcessIdentity | null> {
    return Promise.resolve({ pid, startToken: 't' });
  }
  public check(identity: ProcessIdentity): Promise<LivenessVerdict> {
    return Promise.resolve(this.table.get(`${identity.pid}:${identity.startToken}`) ?? 'dead');
  }
}

function capture(): { stream: Writable; text: () => string } {
  let text = '';
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        text += String(chunk);
        callback();
      },
    }),
    text: () => text,
  };
}

let home: string;
let previousHome: string | undefined;
let probe: TableProbe;
let hosts: RunningHost[];
let failures: Map<number, HostStartFailure>;
let nextPid: number;
let webRoot: string;
let stdout: ReturnType<typeof capture>;
let stderr: ReturnType<typeof capture>;
let context: CommandContext;
let opened: string[];

function lock(): FileHostLock {
  return new FileHostLock({ liveness: probe });
}

/** Starts a host in-process, as `dist/ui-host.js` would, under a fake PID. */
function inProcessSpawn(overrides: { assetsRoot?: string; version?: string } = {}) {
  return (): Promise<SpawnedHost> => {
    const identity = { pid: nextPid++, startToken: 'host' };
    probe.set(identity, 'alive');
    let exited = false;
    void startHostRuntime({
      assetsRoot: overrides.assetsRoot ?? webRoot,
      identity,
      yantraVersion: overrides.version ?? '1.0.0',
      lock: lock(),
    }).then(
      (host) => {
        hosts.push(host);
      },
      (error: unknown) => {
        exited = true;
        probe.set(identity, 'dead');
        if (error instanceof HostStartError) {
          failures.set(identity.pid, {
            pid: identity.pid,
            code: error.code,
            message: error.message,
            remediation: error.remediation,
            at: new Date().toISOString(),
          });
        }
      },
    );
    return Promise.resolve({ pid: identity.pid, exited: () => exited, detach: () => undefined });
  };
}

function deps(overrides: Partial<UiCommandDeps> = {}): UiCommandDeps {
  return {
    probe: () => lock().probe(),
    spawnHost: inProcessSpawn(),
    connectControl: (address, token) => ControlClient.connect(address, token, 2_000),
    openWindow: (url): Promise<WindowOpenResult> => {
      opened.push(url);
      return Promise.resolve({ opened: true, browser: 'Google Chrome', path: '/chrome' });
    },
    readStartFailure: (pid) => Promise.resolve(failures.get(pid) ?? null),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 20))),
    now: Date.now,
    yantraVersion: '1.0.0',
    ...overrides,
  };
}

beforeEach(() => {
  previousHome = process.env.YANTRA_HOME;
  home = mkdtempSync(join(tmpdir(), 'yantra-ui-cmd-'));
  process.env.YANTRA_HOME = home;
  resetPathCache();
  probe = new TableProbe();
  hosts = [];
  failures = new Map();
  nextPid = 900_001;
  webRoot = makeWebBuild();
  stdout = capture();
  stderr = capture();
  context = createTerminalContext({ stdout: stdout.stream, stderr: stderr.stream, env: {} });
  opened = [];
});

afterEach(async () => {
  for (const host of hosts) await host.stop();
  if (previousHome === undefined) delete process.env.YANTRA_HOME;
  else process.env.YANTRA_HOME = previousHome;
  resetPathCache();
  rmSync(home, { recursive: true, force: true });
  cleanupTempDirs();
});

const URL_PATTERN = /^http:\/\/127\.0\.0\.1:\d+\/#code=[A-Za-z0-9_-]{43}\n$/u;

describe('--print', () => {
  it('starts one host and prints a URL with a fragment code', async () => {
    // Arrange
    const spawnHost = vi.fn(inProcessSpawn());

    // Act
    const result = await runUi({ print: true }, context, deps({ spawnHost }));

    // Assert
    expect(result).toEqual({ exitCode: 0 });
    expect(spawnHost).toHaveBeenCalledTimes(1);
    expect(stdout.text()).toMatch(URL_PATTERN);
    expect(opened).toEqual([]);
  });

  it('reuses the running host on a second call and issues a different code', async () => {
    // Arrange
    await runUi({ print: true, json: true }, context, deps());
    const first = UiOpenResult.parse(JSON.parse(stdout.text()));
    const second = capture();
    const spawnHost = vi.fn(inProcessSpawn());

    // Act
    await runUi(
      { print: true, json: true },
      createTerminalContext({ stdout: second.stream, stderr: stderr.stream, env: {} }),
      deps({ spawnHost }),
    );

    // Assert
    const again = UiOpenResult.parse(JSON.parse(second.text()));
    expect(spawnHost).not.toHaveBeenCalled();
    expect(first.reused).toBe(false);
    expect(again.reused).toBe(true);
    expect(again.hostPid).toBe(first.hostPid);
    expect(again.port).toBe(first.port);
    expect(again.url).not.toBe(first.url);
  });

  it('emits exactly the UiOpenResult shape with --json', async () => {
    await runUi({ print: true, json: true }, context, deps());
    const json = JSON.parse(stdout.text()) as Record<string, unknown>;
    expect(Object.keys(json).sort()).toEqual(['hostPid', 'port', 'reused', 'schemaVersion', 'url']);
    expect(UiOpenResult.parse(json)).toEqual(json);
  });

  it('never opens a window', async () => {
    const openWindow = vi.fn();
    await runUi({ print: true }, context, deps({ openWindow }));
    expect(openWindow).not.toHaveBeenCalled();
  });
});

describe('concurrency', () => {
  it('starts exactly one host for two concurrent invocations; the loser reuses it', async () => {
    // Arrange
    const outA = capture();
    const outB = capture();

    // Act
    const [a, b] = await Promise.all([
      runUi(
        { print: true, json: true },
        createTerminalContext({ stdout: outA.stream, stderr: stderr.stream, env: {} }),
        deps(),
      ),
      runUi(
        { print: true, json: true },
        createTerminalContext({ stdout: outB.stream, stderr: stderr.stream, env: {} }),
        deps(),
      ),
    ]);

    // Assert
    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);
    expect(hosts).toHaveLength(1);
    const ra = UiOpenResult.parse(JSON.parse(outA.text()));
    const rb = UiOpenResult.parse(JSON.parse(outB.text()));
    expect(ra.hostPid).toBe(rb.hostPid);
    expect([ra.reused, rb.reused].sort()).toEqual([false, true]);
    expect(ra.url).not.toBe(rb.url);
  });
});

describe('exit 3', () => {
  it('refuses an unknown lock holder with a remediation, without spawning', async () => {
    // Arrange: a live-but-unverifiable host record.
    const holder = { pid: 777, startToken: 'x' };
    probe.set(holder, 'alive');
    await lock().acquire(holder, { build_id: 'b', yantra_version: '1', channel_version: 1 });
    probe.set(holder, 'unknown');
    const spawnHost = vi.fn(inProcessSpawn());

    // Act
    const result = await runUi({ print: true }, context, deps({ spawnHost }));

    // Assert
    expect(result.exitCode).toBe(3);
    expect(result.failure?.code).toBe('host_lock_unverifiable');
    expect(result.failure?.remediation).toContain('delete the host.lock');
    expect(spawnHost).not.toHaveBeenCalled();
    expect(stdout.text()).toBe('');
  });

  it('names host.log when the host never becomes ready', async () => {
    const spawnHost = (): Promise<SpawnedHost> =>
      Promise.resolve({ pid: 5, exited: () => false, detach: () => undefined });
    const result = await runUi({ print: true }, context, deps({ spawnHost, readyTimeoutMs: 200 }));
    expect(result.exitCode).toBe(3);
    expect(result.failure?.code).toBe('host_not_ready');
    expect(result.failure?.remediation).toContain(join(dataDir(), 'ui', 'host.log'));
    expect(stderr.text()).toContain('host.log');
  });

  it('reports missing assets with the rebuild remediation', async () => {
    const result = await runUi(
      { print: true },
      context,
      deps({ spawnHost: inProcessSpawn({ assetsRoot: join(home, 'no-web') }) }),
    );
    expect(result).toMatchObject({
      exitCode: 3,
      failure: { code: 'assets_missing', remediation: 'Rebuild Yantra (pnpm build).' },
    });
  });

  it('reports a host that exited without saying why, naming host.log', async () => {
    const spawnHost = (): Promise<SpawnedHost> =>
      Promise.resolve({ pid: 6, exited: () => true, detach: () => undefined });
    const result = await runUi({ print: true }, context, deps({ spawnHost }));
    expect(result.failure?.code).toBe('host_exited');
    expect(result.failure?.remediation).toContain('host.log');
  });

  it('reports a bind failure from the host', async () => {
    const spawnHost = (): Promise<SpawnedHost> => {
      failures.set(7, {
        pid: 7,
        code: 'bind_failed',
        message: 'The app host could not listen on 127.0.0.1: EACCES.',
        remediation: 'Check that loopback networking is available, then run `yantra ui` again.',
        at: '2026-11-11T10:00:00.000Z',
      });
      return Promise.resolve({ pid: 7, exited: () => true, detach: () => undefined });
    };
    const result = await runUi({ print: true }, context, deps({ spawnHost }));
    expect(result).toMatchObject({ exitCode: 3, failure: { code: 'bind_failed' } });
  });
});

describe('opening a window (TASK-006)', () => {
  it('opens the URL and says which browser', async () => {
    const result = await runUi({}, context, deps());
    expect(result).toEqual({ exitCode: 0 });
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#code=/u);
    expect(stdout.text()).toBe('Opened the Yantra app in Google Chrome.\n');
  });

  it('with no Chromium, exits 3 with the install remediation and still prints the URL', async () => {
    const openWindow = (): Promise<WindowOpenResult> =>
      Promise.resolve({
        opened: false,
        message: 'No Chrome, Edge or Yantra browser was found to open the app.',
        remediation: 'Run `yantra browser install`, or open the URL above in Chrome or Edge.',
      });
    const result = await runUi({}, context, deps({ openWindow }));
    expect(result.exitCode).toBe(3);
    expect(result.failure?.remediation).toBe(
      'Run `yantra browser install`, or open the URL above in Chrome or Edge.',
    );
    expect(stdout.text()).toMatch(URL_PATTERN);
    expect(stderr.text()).toContain('yantra browser install');
  });

  it('with no Chromium and --json, prints the JSON on stdout and the error on stderr', async () => {
    const openWindow = (): Promise<WindowOpenResult> =>
      Promise.resolve({ opened: false, message: 'none', remediation: 'install' });
    const result = await runUi({ json: true }, context, deps({ openWindow }));
    expect(result.exitCode).toBe(3);
    expect(UiOpenResult.parse(JSON.parse(stdout.text())).url).toMatch(/#code=/u);
    expect(stderr.text()).toBe('none install\n');
  });
});

describe('version mismatch', () => {
  it('warns on stderr in human mode when the reused host is another version', async () => {
    await runUi(
      { print: true },
      context,
      deps({ spawnHost: inProcessSpawn({ version: '0.9.0' }) }),
    );
    const err = capture();
    await runUi(
      { print: true },
      createTerminalContext({ stdout: capture().stream, stderr: err.stream, env: {} }),
      deps(),
    );
    expect(err.text()).toBe(
      'The running app is Yantra 0.9.0; close the app and run `yantra ui` to use 1.0.0.\n',
    );
  });

  it('keeps --json unchanged', async () => {
    await runUi(
      { print: true },
      context,
      deps({ spawnHost: inProcessSpawn({ version: '0.9.0' }) }),
    );
    const err = capture();
    await runUi(
      { print: true, json: true },
      createTerminalContext({ stdout: capture().stream, stderr: err.stream, env: {} }),
      deps(),
    );
    expect(err.text()).toBe('');
  });
});

describe('spawning the host process', () => {
  it('is detached, shell-free, stdio-free and carries no code or token', async () => {
    // Arrange
    const calls: { file: string; args: readonly string[]; options: Record<string, unknown> }[] = [];
    const fakeSpawn = ((
      file: string,
      args: readonly string[],
      options: Record<string, unknown>,
    ) => {
      calls.push({ file, args, options });
      const child = new EventEmitter() as EventEmitter & { pid: number; unref: () => void };
      child.pid = 4321;
      child.unref = () => undefined;
      return child;
    }) as unknown as typeof spawn;
    const env = { PATH: 'p', YANTRA_HOME: home };

    // Act
    const spawned = await spawnHostProcess(env, '/abs/dist/ui-host.js', fakeSpawn);
    spawned.detach();

    // Assert
    expect(spawned.pid).toBe(4321);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.file).toBe(process.execPath);
    expect(call.args).toEqual(['/abs/dist/ui-host.js']);
    expect(call.options).toMatchObject({
      cwd: dataDir(),
      env,
      detached: true,
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
    });
    expect(JSON.stringify(call.args)).not.toMatch(/code|token/iu);
  });
});

describe('registry binding', () => {
  it('binds ui to a handler that never exits the process', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const table = uiHandlers(context, () => deps());
    await table.ui([], { print: true }, undefined as never);
    expect(exit).not.toHaveBeenCalled();
    exit.mockRestore();
  });
});
