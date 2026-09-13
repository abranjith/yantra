import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { BrowserProcessError } from '../../src/browser/errors.js';
import { processExists } from '../../src/browser/process-identity.js';
import {
  BrowserProcessSupervisor,
  NodeProcessTreeTerminator,
  type ProcessTreeTerminator,
} from '../../src/browser/process-lifecycle.js';

/** A child-process double that only "exits" when the test says so. */
class FakeChild extends EventEmitter {
  pid: number | undefined = 1234;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;

  /** Simulates a signal that the process ignores — `killed` flips, exit does not. */
  ignoreSignal(): void {
    this.killed = true;
  }

  exit(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }
}

function fakeChild(): { child: ChildProcess; fake: FakeChild } {
  const fake = new FakeChild();
  return { child: fake as unknown as ChildProcess, fake };
}

function recordingTerminator(): ProcessTreeTerminator & { readonly calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    terminate: (pid: number) => {
      calls.push(pid);
      return Promise.resolve();
    },
  };
}

describe('@no-llm BrowserProcessSupervisor', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not report an exit before the exit event fires', () => {
    const { child } = fakeChild();
    const supervisor = new BrowserProcessSupervisor(child);

    expect(supervisor.hasExited()).toBe(false);
  });

  it('treats a process that already exited before wiring as exited', async () => {
    const { child, fake } = fakeChild();
    fake.exitCode = 0;

    const supervisor = new BrowserProcessSupervisor(child);

    expect(supervisor.hasExited()).toBe(true);
    await expect(supervisor.whenExited()).resolves.toBeUndefined();
  });

  it('completes on a graceful close without escalating', async () => {
    const { child, fake } = fakeChild();
    const terminator = recordingTerminator();
    const supervisor = new BrowserProcessSupervisor(child, { terminator });

    const shutting = supervisor.shutdown(() => {
      fake.exit(0);
      return Promise.resolve();
    });

    await shutting;
    expect(terminator.calls).toEqual([]);
    expect(supervisor.hasExited()).toBe(true);
  });

  it('escalates when the graceful close times out', async () => {
    const { child, fake } = fakeChild();
    const terminator: ProcessTreeTerminator = {
      terminate: (pid) => {
        expect(pid).toBe(1234);
        fake.exit(null, 'SIGKILL');
        return Promise.resolve();
      },
    };
    const supervisor = new BrowserProcessSupervisor(child, {
      terminator,
      gracefulCloseMs: 5,
      terminationMs: 50,
    });

    await supervisor.shutdown(() => new Promise(() => undefined));

    expect(supervisor.hasExited()).toBe(true);
    expect(supervisor.exitStatus).toEqual({ code: null, signal: 'SIGKILL' });
  });

  it('escalates when the graceful close rejects', async () => {
    const { child, fake } = fakeChild();
    const terminator: ProcessTreeTerminator = {
      terminate: () => {
        fake.exit(null, 'SIGKILL');
        return Promise.resolve();
      },
    };
    const supervisor = new BrowserProcessSupervisor(child, {
      terminator,
      gracefulCloseMs: 20,
      terminationMs: 50,
    });

    await supervisor.shutdown(() => Promise.reject(new Error('transport already closed')));

    expect(supervisor.hasExited()).toBe(true);
  });

  it('fails with unproven exit when a kill request produces no exit', async () => {
    const { child, fake } = fakeChild();
    const terminator: ProcessTreeTerminator = {
      terminate: () => {
        // A signal was dispatched but the process ignored it. `killed` being
        // true is exactly the false positive this supervisor refuses to accept.
        fake.ignoreSignal();
        return Promise.resolve();
      },
    };
    const supervisor = new BrowserProcessSupervisor(child, {
      terminator,
      gracefulCloseMs: 5,
      terminationMs: 20,
    });

    const error = await supervisor.shutdown().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BrowserProcessError);
    expect((error as BrowserProcessError).context).toMatchObject({
      phase: 'close',
      exitProven: false,
    });
    expect(fake.killed).toBe(true);
    expect(supervisor.hasExited()).toBe(false);
  });

  it('fails with unproven exit when there is no pid to terminate', async () => {
    const { child, fake } = fakeChild();
    fake.pid = undefined;
    const supervisor = new BrowserProcessSupervisor(child, { gracefulCloseMs: 5 });

    await expect(supervisor.shutdown()).rejects.toMatchObject({
      context: { phase: 'close', exitProven: false },
    });
  });

  it('shares one shutdown across concurrent callers', async () => {
    const { child, fake } = fakeChild();
    const terminator = recordingTerminator();
    const supervisor = new BrowserProcessSupervisor(child, {
      terminator,
      gracefulCloseMs: 10,
      terminationMs: 50,
    });
    let gracefulCalls = 0;

    const graceful = (): Promise<void> => {
      gracefulCalls += 1;
      setTimeout(() => fake.exit(0), 1);
      return Promise.resolve();
    };
    await Promise.all([supervisor.shutdown(graceful), supervisor.shutdown(graceful)]);
    await supervisor.shutdown(graceful);

    expect(gracefulCalls).toBe(1);
    expect(terminator.calls).toEqual([]);
  });

  it('returns immediately when the process has already exited', async () => {
    const { child, fake } = fakeChild();
    const terminator = recordingTerminator();
    const supervisor = new BrowserProcessSupervisor(child, { terminator });
    fake.exit(0);
    await supervisor.whenExited();

    await supervisor.shutdown(() => Promise.reject(new Error('should not be called')));

    expect(terminator.calls).toEqual([]);
  });

  it('records a crash exit status without a shutdown request', async () => {
    const { child, fake } = fakeChild();
    const supervisor = new BrowserProcessSupervisor(child);

    fake.exit(139, null);
    await supervisor.whenExited();

    expect(supervisor.exitStatus).toEqual({ code: 139, signal: null });
  });

  it('clears the deadline timers it installs', async () => {
    const { child, fake } = fakeChild();
    const cleared: unknown[] = [];
    const supervisor = new BrowserProcessSupervisor(child, {
      terminator: recordingTerminator(),
      gracefulCloseMs: 50,
      setTimeout: ((fn: () => void, ms: number) => setTimeout(fn, ms)) as typeof setTimeout,
      clearTimeout: ((handle: unknown) => {
        cleared.push(handle);
        clearTimeout(handle as ReturnType<typeof setTimeout>);
      }) as typeof clearTimeout,
    });

    await supervisor.shutdown(() => {
      fake.exit(0);
      return Promise.resolve();
    });

    expect(cleared).toHaveLength(1);
  });
});

describe('@no-llm process termination against a real process', () => {
  const spawned: ChildProcess[] = [];

  afterEach(() => {
    for (const child of spawned.splice(0)) if (child.exitCode === null) child.kill('SIGKILL');
  });

  function spawnSleeper(): ChildProcess {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    spawned.push(child);
    return child;
  }

  it('terminates a real unresponsive process and proves it exited', async () => {
    const child = spawnSleeper();
    const supervisor = new BrowserProcessSupervisor(child, {
      terminator: new NodeProcessTreeTerminator({ hardKillDelayMs: 200 }),
      gracefulCloseMs: 50,
      terminationMs: 10_000,
    });

    // The "graceful" close never completes — exactly the hung-browser case.
    await supervisor.shutdown(() => new Promise(() => undefined));

    expect(supervisor.hasExited()).toBe(true);
    expect(processExists(child.pid!)).toBe(false);
  }, 30_000);

  it('reports exit for a real process that ends on its own', async () => {
    const child = spawn(process.execPath, ['-e', 'process.exit(7)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    spawned.push(child);
    const supervisor = new BrowserProcessSupervisor(child);

    await supervisor.whenExited();

    expect(supervisor.exitStatus?.code).toBe(7);
    // A second shutdown on an already-exited process is a no-op, not a signal.
    await expect(supervisor.shutdown()).resolves.toBeUndefined();
  }, 30_000);
});
