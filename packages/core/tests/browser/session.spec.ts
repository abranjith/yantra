import { EventEmitter } from 'node:events';

import type { Browser } from 'puppeteer-core';
import { describe, expect, it, vi } from 'vitest';

import { BrowserCrashedError } from '../../src/browser/errors.js';
import type { ResolvedBrowserInstallation } from '../../src/browser/installation-types.js';
import type { OwnedBrowserProcess } from '../../src/browser/launcher.js';
import type { BrowserProcessSupervisor } from '../../src/browser/process-lifecycle.js';
import { LocalBrowserSession } from '../../src/browser/session.js';
import type { Logger, ProfileStore, ResolvedProfile } from '../../src/browser/types.js';

vi.mock('../../src/locator/injected-host.js', () => ({
  PuppeteerInjectedScriptHost: vi.fn().mockImplementation(() => ({})),
}));

function installation(
  overrides: Partial<ResolvedBrowserInstallation> = {},
): ResolvedBrowserInstallation {
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
    ...overrides,
  };
}

class FakeChild extends EventEmitter {
  pid: number | undefined = 4321;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stderr = new EventEmitter();

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.emit('exit', code, signal);
  }
}

interface Fixture {
  readonly session: LocalBrowserSession;
  readonly child: FakeChild;
  readonly browser: EventEmitter & { pages: () => Promise<unknown[]> };
  readonly shutdowns: () => number;
  readonly cleaned: string[];
  readonly newPageCalls: () => number;
  onCleanup(hook: () => void): void;
}

function makeFixture(
  opts: {
    profileKind?: ResolvedProfile['kind'];
    pages?: { url: () => string }[];
    shutdownError?: Error;
    cleanupError?: Error;
    installation?: ResolvedBrowserInstallation;
    onShutdown?: () => void;
  } = {},
): Fixture {
  const child = new FakeChild();
  let shutdowns = 0;
  let newPageCalls = 0;
  const cleaned: string[] = [];

  const browserEvents = new EventEmitter();
  const browser = Object.assign(browserEvents, {
    pages: () => Promise.resolve(opts.pages ?? []),
    newPage: () => {
      newPageCalls += 1;
      return Promise.resolve({ url: () => 'about:blank', on: vi.fn() });
    },
    close: () => Promise.resolve(),
  });

  const launched: OwnedBrowserProcess = {
    browser: browser as unknown as Browser,
    child: child as never,
    supervisor: {
      hasExited: () => child.exitCode !== null,
      whenExited: () => Promise.resolve(),
    } as unknown as BrowserProcessSupervisor,
    ownership: { kind: 'external' },
    shutdown: () => {
      shutdowns += 1;
      opts.onShutdown?.();
      return opts.shutdownError ? Promise.reject(opts.shutdownError) : Promise.resolve();
    },
  };
  const cleanupHooks: (() => void)[] = [];

  const profile: ResolvedProfile = {
    absolutePath: '/tmp/yantra-profile',
    kind: opts.profileKind ?? 'ephemeral',
    createdNow: true,
  };

  const profileStore: ProfileStore = {
    resolve: () => Promise.resolve(profile),
    listWorkflowProfiles: () => Promise.resolve([]),
    removeWorkflowProfile: () => Promise.resolve(),
    cleanupEphemeral: (path) => {
      cleaned.push(path);
      for (const hook of cleanupHooks) hook();
      return opts.cleanupError ? Promise.reject(opts.cleanupError) : Promise.resolve();
    },
  };

  const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

  const session = new LocalBrowserSession({
    launched,
    installation: opts.installation ?? installation(),
    profile,
    profileStore,
    logger,
  });

  return {
    session,
    child,
    browser: browser as unknown as EventEmitter & { pages: () => Promise<unknown[]> },
    shutdowns: () => shutdowns,
    cleaned,
    newPageCalls: () => newPageCalls,
    onCleanup: (hook: () => void) => cleanupHooks.push(hook),
  };
}

describe('@no-llm LocalBrowserSession identity', () => {
  it('has a unique id per session', () => {
    expect(makeFixture().session.id).not.toBe(makeFixture().session.id);
  });

  it('exposes the resolved installation and its legacy projection', () => {
    const { session } = makeFixture();

    expect(session.installation.canonicalPath).toBe('/usr/bin/google-chrome');
    expect(session.chrome).toMatchObject({
      path: '/usr/bin/google-chrome',
      version: '153.0.8010.36',
      source: 'system',
    });
  });

  it('projects managed ownership into the legacy chrome metadata', () => {
    const { session } = makeFixture({ installation: installation({ ownership: 'managed' }) });

    expect(session.chrome.source).toBe('managed');
    expect(session.installation.ownership).toBe('managed');
  });

  it('exposes the profile path', () => {
    expect(makeFixture().session.profilePath).toBe('/tmp/yantra-profile');
  });
});

describe('@no-llm LocalBrowserSession newPage', () => {
  it('reuses the initial about:blank tab exactly once', async () => {
    const fixture = makeFixture({ pages: [{ url: () => 'about:blank' }] });

    await fixture.session.newPage();
    await fixture.session.newPage();

    expect(fixture.newPageCalls()).toBe(1);
  });

  it('emits page-created', async () => {
    const fixture = makeFixture();
    const created = vi.fn();
    fixture.session.on('page-created', created);

    await fixture.session.newPage();

    expect(created).toHaveBeenCalled();
  });

  it('refuses a new page after close', async () => {
    const fixture = makeFixture();
    await fixture.session.close();

    await expect(fixture.session.newPage()).rejects.toBeInstanceOf(BrowserCrashedError);
  });

  it('refuses a new page after a crash', async () => {
    const fixture = makeFixture();
    fixture.child.exit(1);

    await expect(fixture.session.newPage()).rejects.toBeInstanceOf(BrowserCrashedError);
  });
});

describe('@no-llm LocalBrowserSession close', () => {
  it('delegates process supervision rather than signalling directly', async () => {
    const fixture = makeFixture();

    await fixture.session.close();

    expect(fixture.shutdowns()).toBe(1);
  });

  it('is idempotent and shares one shutdown across concurrent callers', async () => {
    const fixture = makeFixture();

    await Promise.all([fixture.session.close(), fixture.session.close()]);
    await fixture.session.close();

    expect(fixture.shutdowns()).toBe(1);
    expect(fixture.cleaned).toEqual(['/tmp/yantra-profile']);
  });

  it('removes the ephemeral profile only after the process shutdown resolved', async () => {
    const order: string[] = [];
    const fixture = makeFixture({ onShutdown: () => order.push('shutdown') });
    fixture.onCleanup(() => order.push('cleanup'));

    await fixture.session.close();

    expect(order).toEqual(['shutdown', 'cleanup']);
  });

  it.each(['workflow', 'explicit'] as const)('never removes a %s profile', async (kind) => {
    const fixture = makeFixture({ profileKind: kind });

    await fixture.session.close();

    expect(fixture.cleaned).toEqual([]);
  });

  it('still removes the ephemeral profile when process shutdown fails', async () => {
    const fixture = makeFixture({ shutdownError: new Error('process would not exit') });

    await expect(fixture.session.close()).rejects.toThrow(/would not exit/);

    expect(fixture.cleaned).toEqual(['/tmp/yantra-profile']);
  });

  it('does not fail close when profile cleanup fails', async () => {
    const fixture = makeFixture({ cleanupError: new Error('EBUSY') });

    await expect(fixture.session.close()).resolves.toBeUndefined();
  });
});

describe('@no-llm LocalBrowserSession crash handling', () => {
  it('emits crashed with the exit status when the child exits unexpectedly', async () => {
    const fixture = makeFixture();
    const crashed = vi.fn();
    fixture.session.on('crashed', crashed);

    fixture.child.stderr.emit('data', 'segfault detail');
    fixture.child.exit(139, 'SIGSEGV');
    await vi.waitFor(() => expect(crashed).toHaveBeenCalled());

    const error = crashed.mock.calls[0]![0] as BrowserCrashedError;
    expect(error).toBeInstanceOf(BrowserCrashedError);
    expect(error.context.exitCode).toBe(139);
    expect(error.context.lastStderr).toContain('segfault detail');
  });

  it('accounts for ownership after a crash by releasing the owned process', async () => {
    const fixture = makeFixture();

    fixture.child.exit(1);
    await vi.waitFor(() => expect(fixture.shutdowns()).toBe(1));
    await vi.waitFor(() => expect(fixture.cleaned).toEqual(['/tmp/yantra-profile']));
  });

  it('does not emit crashed when close initiated the exit', async () => {
    const fixture = makeFixture();
    const crashed = vi.fn();
    fixture.session.on('crashed', crashed);

    await fixture.session.close();
    fixture.child.exit(0);

    expect(crashed).not.toHaveBeenCalled();
  });

  it('stays closeable after a crash', async () => {
    const fixture = makeFixture();
    fixture.child.exit(1);
    await vi.waitFor(() => expect(fixture.shutdowns()).toBe(1));

    await expect(fixture.session.close()).resolves.toBeUndefined();
  });

  it('emits disconnected when the transport drops without an exit', () => {
    const fixture = makeFixture();
    const disconnected = vi.fn();
    fixture.session.on('disconnected', disconnected);

    fixture.browser.emit('disconnected');

    expect(disconnected).toHaveBeenCalled();
  });

  it('survives a handler that throws', () => {
    const fixture = makeFixture();
    fixture.session.on('disconnected', () => {
      throw new Error('handler exploded');
    });

    expect(() => fixture.browser.emit('disconnected')).not.toThrow();
  });
});
