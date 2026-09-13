import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

import type { Browser } from 'puppeteer-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BrowserLaunchError, BrowserProcessError } from '../../src/browser/errors.js';
import type {
  ProcessIdentity,
  ResolvedBrowserInstallation,
} from '../../src/browser/installation-types.js';
import {
  DEFAULT_STARTUP_TIMEOUT_MS,
  DEFAULT_VIEWPORT,
  parseLaunchOptions,
} from '../../src/browser/launch-options.js';
import {
  buildLaunchArgs,
  launchResolvedChrome,
  type LaunchOwnership,
} from '../../src/browser/launcher.js';
import type { OwnedManagedUseReservation } from '../../src/browser/managed-coordination.js';
import { processExists } from '../../src/browser/process-identity.js';
import { NodeProcessTreeTerminator } from '../../src/browser/process-lifecycle.js';
import type { ChromeInstall, ResolvedProfile } from '../../src/browser/types.js';

// buildLaunchArgs is snapshot-tested here; the ownership and process-exit
// guarantees around it are asserted below against fakes and real processes.

const stubChrome: ChromeInstall = {
  path: '/usr/bin/google-chrome',
  version: '124.0.6367.91',
  majorVersion: 124,
  channel: 'stable',
  source: 'system',
};

const ephemeralProfile: ResolvedProfile = {
  absolutePath: '/tmp/yantra-test-uuid',
  kind: 'ephemeral',
  createdNow: true,
};

function makeOpts(overrides: Record<string, unknown> = {}) {
  return parseLaunchOptions({ profile: { kind: 'ephemeral' }, ...overrides });
}

describe('@no-llm launcher buildLaunchArgs', () => {
  it('snapshot: default headless args', () => {
    const opts = makeOpts();
    const args = buildLaunchArgs(opts, stubChrome, { platform: 'linux', locale: 'en-US' });
    expect(args).toMatchSnapshot();
  });

  it('always includes hardened base args', () => {
    const args = buildLaunchArgs(makeOpts(), stubChrome);
    expect(args).toContain('--no-first-run');
    expect(args).toContain('--no-default-browser-check');
    expect(args).toContain('--disable-sync');
  });

  it('never includes --remote-debugging-port', () => {
    const args = buildLaunchArgs(makeOpts(), stubChrome);
    const hasPort = args.some((a) => a.startsWith('--remote-debugging-port'));
    expect(hasPort).toBe(false);
  });

  it('never includes --user-data-dir (handled by userDataDir option)', () => {
    const args = buildLaunchArgs(makeOpts(), stubChrome);
    const hasDataDir = args.some((a) => a.startsWith('--user-data-dir'));
    expect(hasDataDir).toBe(false);
  });

  it('adds --window-size when viewport specified', () => {
    const args = buildLaunchArgs(makeOpts({ viewport: { width: 1920, height: 1080 } }), stubChrome);
    expect(args).toContain('--window-size=1920,1080');
  });

  it('omits --window-size when viewport is null', () => {
    const args = buildLaunchArgs(makeOpts({ viewport: null }), stubChrome);
    const hasWindowSize = args.some((a) => a.startsWith('--window-size'));
    expect(hasWindowSize).toBe(false);
  });

  it('appends extraArgs after base args', () => {
    const args = buildLaunchArgs(makeOpts({ extraArgs: ['--disable-gpu'] }), stubChrome);
    expect(args).toContain('--disable-gpu');
    // extraArgs come after the hardened base
    const baseEnd = args.indexOf('--disable-sync');
    const extraIdx = args.indexOf('--disable-gpu');
    expect(extraIdx).toBeGreaterThan(baseEnd);
  });

  it('default viewport args snapshot', () => {
    const opts = makeOpts({ viewport: DEFAULT_VIEWPORT });
    const args = buildLaunchArgs(opts, stubChrome);
    expect(args).toContain(`--window-size=${DEFAULT_VIEWPORT.width},${DEFAULT_VIEWPORT.height}`);
  });

  // Satisfy linting — references
  it('uses stub chrome and profile types', () => {
    expect(stubChrome.source).toBe('system');
    expect(ephemeralProfile.kind).toBe('ephemeral');
    expect(DEFAULT_STARTUP_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

describe('@no-llm BrowserLaunchError', () => {
  it('carries phase and lastStderr context', () => {
    const err = new BrowserLaunchError({ phase: 'timeout', lastStderr: 'stderr text', args: [] });
    expect(err.context.phase).toBe('timeout');
    expect(err.context.lastStderr).toBe('stderr text');
    expect(err.name).toBe('BrowserLaunchError');
  });
});

const profile: ResolvedProfile = {
  absolutePath: '/tmp/yantra-launcher-test',
  kind: 'ephemeral',
  createdNow: true,
};

function installation(): ResolvedBrowserInstallation {
  return {
    canonicalPath: '/usr/bin/google-chrome',
    version: '153.0.8010.36',
    majorVersion: 153,
    platform: 'linux',
    architecture: 'x64',
    statFingerprint: '1:2:3:4',
    ownership: 'external',
    requestedSelection: { source: 'auto', executablePath: null },
    selectionOrigin: 'default',
    selectionReason: 'system-discovery',
    channel: 'stable',
    managedIdentity: null,
  };
}

class FakeChild extends EventEmitter {
  pid: number | undefined = 5150;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;

  exit(code: number | null = 0): void {
    this.exitCode = code;
    this.emit('exit', code, null);
  }
}

interface FakeBrowser {
  readonly browser: Browser;
  readonly child: FakeChild;
  readonly closes: () => number;
}

function fakeBrowser(
  opts: { withChild?: boolean; closeBehavior?: 'exit' | 'hang' } = {},
): FakeBrowser {
  const child = new FakeChild();
  let closes = 0;
  const browser = {
    process: () => (opts.withChild === false ? null : (child as unknown as ChildProcess)),
    close: () => {
      closes += 1;
      if (opts.closeBehavior !== 'hang') child.exit(0);
      return Promise.resolve();
    },
  } as unknown as Browser;
  return { browser, child, closes: () => closes };
}

/** A reservation double that records the ordering the contract depends on. */
function fakeReservation(overrides: Partial<OwnedManagedUseReservation> = {}) {
  const events: string[] = [];
  const reservation: OwnedManagedUseReservation = {
    id: 'res-1',
    installationId: 'abc123',
    phase: 'starting',
    attachChild: (child: ProcessIdentity) => {
      events.push(`attach:${child.pid}`);
      return Promise.resolve();
    },
    releaseAfterExit: () => {
      events.push('release');
      return Promise.resolve();
    },
    markNeverSpawned: () => {
      events.push('never-spawned');
      return Promise.resolve();
    },
    ...overrides,
  };
  return { reservation, events };
}

function opts(overrides: Record<string, unknown> = {}) {
  return parseLaunchOptions({ profile: { kind: 'ephemeral' }, ...overrides });
}

describe('@no-llm launchResolvedChrome — startup failures', () => {
  it('maps a native launch rejection to a connect failure', async () => {
    const error = await launchResolvedChrome(
      opts(),
      installation(),
      profile,
      { kind: 'external' },
      { launch: () => Promise.reject(new Error('spawn ENOENT')) },
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BrowserLaunchError);
    expect((error as BrowserLaunchError).context.phase).toBe('connect');
    // The stderr surface never carries the launch argument list.
    expect((error as BrowserLaunchError).context.args).toEqual(['<redacted>']);
  });

  it('fails with a timeout when startup does not complete in time', async () => {
    const error = await launchResolvedChrome(
      opts({ startupTimeoutMs: 20 }),
      installation(),
      profile,
      { kind: 'external' },
      { launch: () => new Promise(() => undefined) },
    ).catch((e: unknown) => e);

    expect((error as BrowserLaunchError).context.phase).toBe('timeout');
  });

  it('closes and awaits a browser that arrives late after the timeout', async () => {
    const late = fakeBrowser();
    let resolveLate!: (b: Browser) => void;
    const launching = new Promise<Browser>((r) => {
      resolveLate = r;
    });

    const error = await launchResolvedChrome(
      opts({ startupTimeoutMs: 10 }),
      installation(),
      profile,
      { kind: 'external' },
      { launch: () => launching, gracefulCloseMs: 100, terminationMs: 100 },
    ).catch((e: unknown) => e);
    expect((error as BrowserLaunchError).context.phase).toBe('timeout');

    resolveLate(late.browser);
    await vi.waitFor(() => expect(late.closes()).toBe(1));
    // A late arrival is not merely closed — its process exit is awaited.
    expect(late.child.exitCode).toBe(0);
  });

  it('closes and awaits a browser that arrives after cancellation', async () => {
    const late = fakeBrowser();
    let resolveLate!: (b: Browser) => void;
    const launching = new Promise<Browser>((r) => {
      resolveLate = r;
    });
    const controller = new AbortController();
    const launched = launchResolvedChrome(
      opts({ startupTimeoutMs: 5_000 }),
      installation(),
      profile,
      { kind: 'external' },
      { launch: () => launching, signal: controller.signal, gracefulCloseMs: 100 },
    );

    controller.abort();
    await expect(launched).rejects.toBeInstanceOf(BrowserLaunchError);

    resolveLate(late.browser);
    await vi.waitFor(() => expect(late.closes()).toBe(1));
  });

  it('disposes the browser when no process handle is available', async () => {
    const withoutChild = fakeBrowser({ withChild: false });

    const error = await launchResolvedChrome(
      opts(),
      installation(),
      profile,
      { kind: 'external' },
      { launch: () => Promise.resolve(withoutChild.browser) },
    ).catch((e: unknown) => e);

    expect((error as BrowserLaunchError).context.lastStderr).toMatch(/child process handle/);
    expect(withoutChild.closes()).toBe(1);
  });

  it('rolls the managed reservation back with never-spawned proof when launch fails', async () => {
    const { reservation, events } = fakeReservation();

    await expect(
      launchResolvedChrome(
        opts(),
        installation(),
        profile,
        { kind: 'managed', reservation },
        { launch: () => Promise.reject(new Error('spawn ENOENT')) },
      ),
    ).rejects.toBeInstanceOf(BrowserLaunchError);

    expect(events).toEqual(['never-spawned']);
  });

  it('shuts the browser down when the reservation refuses the child registration', async () => {
    const running = fakeBrowser();
    const { reservation, events } = fakeReservation({
      attachChild: () => Promise.reject(new Error('coordination unavailable')),
    });

    await expect(
      launchResolvedChrome(
        opts(),
        installation(),
        profile,
        { kind: 'managed', reservation },
        {
          launch: () => Promise.resolve(running.browser),
          identify: (pid) => Promise.resolve({ pid, startToken: 'token' }),
          gracefulCloseMs: 100,
        },
      ),
    ).rejects.toThrow(/coordination unavailable/);

    expect(running.closes()).toBe(1);
    expect(running.child.exitCode).toBe(0);
    expect(events).toEqual(['release']);
  });
});

describe('@no-llm launchResolvedChrome — ownership ordering', () => {
  it('records the browser child as soon as a handle exists', async () => {
    const running = fakeBrowser();
    const { reservation, events } = fakeReservation();

    const launched = await launchResolvedChrome(
      opts(),
      installation(),
      profile,
      { kind: 'managed', reservation },
      {
        launch: () => Promise.resolve(running.browser),
        identify: (pid) => Promise.resolve({ pid, startToken: 'token' }),
      },
    );

    expect(events).toEqual(['attach:5150']);
    expect(launched.child.pid).toBe(5150);
  });

  it('releases the reservation strictly after the process has exited', async () => {
    const running = fakeBrowser();
    const order: string[] = [];
    const { reservation } = fakeReservation({
      releaseAfterExit: () => {
        order.push(`release(exited=${String(running.child.exitCode !== null)})`);
        return Promise.resolve();
      },
    });
    const launched = await launchResolvedChrome(
      opts(),
      installation(),
      profile,
      { kind: 'managed', reservation },
      {
        launch: () => Promise.resolve(running.browser),
        identify: (pid) => Promise.resolve({ pid, startToken: 'token' }),
        gracefulCloseMs: 200,
      },
    );

    await launched.shutdown();

    expect(order).toEqual(['release(exited=true)']);
  });

  it('keeps the reservation and reports typed evidence when cleanup cannot finish', async () => {
    const hanging = fakeBrowser({ closeBehavior: 'hang' });
    const { reservation } = fakeReservation();
    const launched = await launchResolvedChrome(
      opts(),
      installation(),
      profile,
      { kind: 'managed', reservation },
      {
        launch: () => Promise.resolve(hanging.browser),
        identify: (pid) => Promise.resolve({ pid, startToken: 'token' }),
        terminator: { terminate: () => Promise.resolve() },
        gracefulCloseMs: 10,
        terminationMs: 20,
      },
    );

    const error = await launched.shutdown().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BrowserProcessError);
    expect((error as BrowserProcessError).context.exitProven).toBe(false);
  });

  it('reports unproven cleanup when the reservation refuses to release', async () => {
    const running = fakeBrowser();
    const { reservation } = fakeReservation({
      releaseAfterExit: () => Promise.reject(new Error('browser still alive')),
    });
    const launched = await launchResolvedChrome(
      opts(),
      installation(),
      profile,
      { kind: 'managed', reservation },
      {
        launch: () => Promise.resolve(running.browser),
        identify: (pid) => Promise.resolve({ pid, startToken: 'token' }),
        gracefulCloseMs: 100,
      },
    );

    const error = await launched.shutdown().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BrowserProcessError);
    expect((error as BrowserProcessError).context).toMatchObject({
      phase: 'cleanup',
      exitProven: true,
    });
  });

  it('shares one shutdown across repeated and concurrent calls', async () => {
    const running = fakeBrowser();
    let releases = 0;
    const { reservation } = fakeReservation({
      releaseAfterExit: () => {
        releases += 1;
        return Promise.resolve();
      },
    });
    const launched = await launchResolvedChrome(
      opts(),
      installation(),
      profile,
      { kind: 'managed', reservation },
      {
        launch: () => Promise.resolve(running.browser),
        identify: (pid) => Promise.resolve({ pid, startToken: 'token' }),
        gracefulCloseMs: 200,
      },
    );

    await Promise.all([launched.shutdown(), launched.shutdown()]);
    await launched.shutdown();

    expect(running.closes()).toBe(1);
    expect(releases).toBe(1);
  });

  it('takes no reservation action for an external session', async () => {
    const running = fakeBrowser();
    const ownership: LaunchOwnership = { kind: 'external' };

    const launched = await launchResolvedChrome(opts(), installation(), profile, ownership, {
      launch: () => Promise.resolve(running.browser),
      gracefulCloseMs: 200,
    });
    await launched.shutdown();

    expect(launched.ownership).toEqual({ kind: 'external' });
    expect(running.child.exitCode).toBe(0);
  });

  it('survives a crash before shutdown and still reports the exit', async () => {
    const running = fakeBrowser();
    const { reservation, events } = fakeReservation();
    const launched = await launchResolvedChrome(
      opts(),
      installation(),
      profile,
      { kind: 'managed', reservation },
      {
        launch: () => Promise.resolve(running.browser),
        identify: (pid) => Promise.resolve({ pid, startToken: 'token' }),
      },
    );

    running.child.exit(139);
    await launched.shutdown();

    expect(launched.supervisor.exitStatus).toEqual({ code: 139, signal: null });
    expect(events).toEqual(['attach:5150', 'release']);
  });
});

describe('@no-llm launchResolvedChrome — real process termination', () => {
  const spawned: ChildProcess[] = [];

  afterEach(() => {
    for (const child of spawned.splice(0)) if (child.exitCode === null) child.kill('SIGKILL');
  });

  it('kills a real unresponsive browser process and proves the tree exited', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    spawned.push(child);
    const browser = {
      process: () => child,
      close: () => new Promise<void>(() => undefined),
    } as unknown as Browser;
    const { reservation, events } = fakeReservation();

    const launched = await launchResolvedChrome(
      opts(),
      installation(),
      profile,
      { kind: 'managed', reservation },
      {
        launch: () => Promise.resolve(browser),
        terminator: new NodeProcessTreeTerminator({ hardKillDelayMs: 200 }),
        gracefulCloseMs: 100,
        terminationMs: 10_000,
      },
    );

    await launched.shutdown();

    expect(processExists(child.pid!)).toBe(false);
    // Release happens only after the real process is gone.
    expect(events[events.length - 1]).toBe('release');
  }, 30_000);
});
