import { EventEmitter } from 'node:events';

import type { Browser } from 'puppeteer-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as resolverModule from '../../src/browser/browser-resolver.js';
import {
  BrowserCompatibilityError,
  BrowserResolutionError,
  ManagedCoordinationError,
} from '../../src/browser/errors.js';
import type {
  BrowserResolution,
  BrowserRuntimeServices,
  CompatibilityResult,
  ManagedReadyRecord,
  ProbeProfile,
  ResolvedBrowserInstallation,
} from '../../src/browser/installation-types.js';
import * as launcher from '../../src/browser/launcher.js';
import type { OwnedBrowserProcess } from '../../src/browser/launcher.js';
import type { OwnedManagedUseReservation } from '../../src/browser/managed-coordination.js';
import type { BrowserProcessSupervisor } from '../../src/browser/process-lifecycle.js';
import { LocalBrowserProvider } from '../../src/browser/provider.js';
import type { Logger, ProfileStore, ResolvedProfile } from '../../src/browser/types.js';

vi.mock('../../src/browser/launcher.js', async (importOriginal) => ({
  ...(await importOriginal<typeof launcher>()),
  launchResolvedChrome: vi.fn(),
}));

const mockLaunch = vi.mocked(launcher.launchResolvedChrome);

const READY_RECORD: ManagedReadyRecord = {
  schemaVersion: 1,
  installationId: 'abc123',
  browser: 'chrome',
  platform: 'linux',
  buildId: '153.0.8010.36',
  cacheRootRelative: 'installation-abc123',
  executableRelative: 'chrome/linux-153.0.8010.36/chrome-linux64/chrome',
  verifiedAt: '2026-09-12T00:00:00.000Z',
};

function makeInstallation(
  overrides: Partial<ResolvedBrowserInstallation> = {},
): ResolvedBrowserInstallation {
  return {
    canonicalPath: '/usr/bin/google-chrome',
    version: '153.0.8010.36',
    majorVersion: 153,
    platform: 'linux',
    architecture: 'x64',
    statFingerprint: 'size:mtime:dev:ino',
    ownership: 'external',
    requestedSelection: { source: 'auto', executablePath: null },
    selectionOrigin: 'default',
    selectionReason: 'system-discovery',
    channel: 'stable',
    managedIdentity: null,
    ...overrides,
  };
}

function managedInstallation(): ResolvedBrowserInstallation {
  return makeInstallation({
    ownership: 'managed',
    selectionReason: 'managed-preferred',
    managedIdentity: READY_RECORD,
    canonicalPath:
      '/data/browsers/installation-abc123/chrome/linux-153.0.8010.36/chrome-linux64/chrome',
  });
}

function passing(
  installation: ResolvedBrowserInstallation,
  profile: ProbeProfile = 'automation',
): CompatibilityResult {
  return {
    schemaVersion: 1,
    identity: installation,
    driverVersion: '25.10.0',
    testedBuild: '152.0.7977.75',
    probeRevision: 1,
    capabilityTableHash: 'hash',
    profile,
    checkedAt: '2026-09-13T00:00:00.000Z',
    capabilities: [{ capability: 'pipe-version', status: 'passed', reason: null }],
    verdict: { status: 'passed', pairing: 'capability-checked' },
  };
}

function failing(installation: ResolvedBrowserInstallation): CompatibilityResult {
  return {
    ...passing(installation),
    capabilities: [
      { capability: 'pipe-version', status: 'passed', reason: null },
      { capability: 'click-replace', status: 'failed', reason: 'appended instead of replacing' },
    ],
    verdict: {
      status: 'failed',
      failureClass: 'capability-failure',
      remediation: 'Install a current Chrome or Chromium.',
    },
  };
}

class FakeChild extends EventEmitter {
  pid: number | undefined = 4321;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stderr = null;
}

interface Recorder {
  readonly events: string[];
}

function makeProfileStore(recorder: Recorder, overrides: Partial<ProfileStore> = {}): ProfileStore {
  return {
    resolve: (spec) => {
      recorder.events.push(`profile:${spec.kind}`);
      return Promise.resolve({
        absolutePath: `/tmp/yantra-${spec.kind}`,
        kind: spec.kind,
        createdNow: true,
      } satisfies ResolvedProfile);
    },
    listWorkflowProfiles: () => Promise.resolve([]),
    removeWorkflowProfile: () => Promise.resolve(),
    cleanupEphemeral: (path) => {
      recorder.events.push(`cleanup:${path}`);
      return Promise.resolve();
    },
    ...overrides,
  };
}

function makeServices(
  recorder: Recorder,
  opts: {
    resolution?: BrowserResolution;
    compatibility?: CompatibilityResult;
    reserveError?: Error;
  } = {},
): { services: BrowserRuntimeServices; reservation: OwnedManagedUseReservation } {
  const resolution =
    opts.resolution ?? ({ status: 'resolved', installation: makeInstallation() } as const);
  const reservation: OwnedManagedUseReservation = {
    id: 'res-1',
    installationId: 'abc123',
    phase: 'starting',
    attachChild: () => {
      recorder.events.push('reservation:attach');
      return Promise.resolve();
    },
    releaseAfterExit: () => {
      recorder.events.push('reservation:release');
      return Promise.resolve();
    },
    markNeverSpawned: () => {
      recorder.events.push('reservation:never-spawned');
      return Promise.resolve();
    },
  };
  const services: BrowserRuntimeServices = {
    resolver: { resolve: vi.fn().mockResolvedValue(resolution) },
    compatibility: {
      check: vi.fn((installation: ResolvedBrowserInstallation) => {
        recorder.events.push('compatibility:check');
        return Promise.resolve(opts.compatibility ?? passing(installation));
      }),
      readCached: vi.fn().mockResolvedValue({ state: 'unverified' }),
    },
    coordinator: {
      reserveUse: vi.fn(() => {
        recorder.events.push('reservation:acquire');
        if (opts.reserveError) return Promise.reject(opts.reserveError);
        return Promise.resolve(reservation);
      }),
      claimMutation: vi.fn(),
      hasActiveUse: vi.fn().mockResolvedValue(false),
    },
    managedState: {
      readReady: vi.fn().mockResolvedValue({ status: 'ready', record: READY_RECORD }),
      readInventory: vi.fn().mockResolvedValue({
        ready: { status: 'ready', record: READY_RECORD },
        orphans: [],
      }),
    },
  };
  return { services, reservation };
}

function makeLaunched(recorder: Recorder, pages: unknown[] = []): OwnedBrowserProcess {
  const child = new FakeChild();
  const browser = {
    on: vi.fn(),
    pages: () => Promise.resolve(pages),
    newPage: () => Promise.resolve({ url: () => 'about:blank' }),
    close: () => Promise.resolve(),
  } as unknown as Browser;
  return {
    browser,
    child: child as never,
    supervisor: {
      hasExited: () => false,
      whenExited: () => Promise.resolve(),
    } as unknown as BrowserProcessSupervisor,
    ownership: { kind: 'external' },
    shutdown: () => {
      recorder.events.push('process:shutdown');
      return Promise.resolve();
    },
  };
}

const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

describe('@no-llm LocalBrowserProvider startup', () => {
  let recorder: Recorder;

  beforeEach(() => {
    vi.clearAllMocks();
    recorder = { events: [] };
    vi.spyOn(resolverModule, 'identifyExecutable').mockImplementation((path) =>
      Promise.resolve({
        canonicalPath: path,
        version: '153.0.8010.36',
        majorVersion: 153,
        platform: 'linux',
        architecture: 'x64',
        statFingerprint: 'size:mtime:dev:ino',
      }),
    );
  });

  it('launches an external browser and hands the session its resolved identity', async () => {
    const { services } = makeServices(recorder);
    mockLaunch.mockResolvedValue(makeLaunched(recorder));
    const provider = new LocalBrowserProvider({
      profileStore: makeProfileStore(recorder),
      services,
      logger,
    });

    const session = await provider.launch({ profile: { kind: 'ephemeral' } });

    expect(session.chrome).toMatchObject({ path: '/usr/bin/google-chrome', source: 'system' });
    const ownership = mockLaunch.mock.calls[0]![3];
    expect(ownership).toEqual({ kind: 'external' });
    expect(recorder.events).not.toContain('reservation:acquire');
  });

  it('launches a seeded-ready managed browser under one reservation', async () => {
    const installation = managedInstallation();
    const { services, reservation } = makeServices(recorder, {
      resolution: { status: 'resolved', installation },
    });
    mockLaunch.mockResolvedValue(makeLaunched(recorder));
    const provider = new LocalBrowserProvider({
      profileStore: makeProfileStore(recorder),
      services,
      logger,
    });

    const session = await provider.launch({ profile: { kind: 'ephemeral' } });

    expect(session.chrome.source).toBe('managed');
    expect(services.coordinator.reserveUse).toHaveBeenCalledTimes(1);
    expect(mockLaunch.mock.calls[0]![3]).toEqual({ kind: 'managed', reservation });
  });

  it('holds one reservation continuously across the probe and the task launch', async () => {
    const { services } = makeServices(recorder, {
      resolution: { status: 'resolved', installation: managedInstallation() },
    });
    mockLaunch.mockResolvedValue(makeLaunched(recorder));
    const provider = new LocalBrowserProvider({
      profileStore: makeProfileStore(recorder),
      services,
      logger,
    });

    await provider.launch({ profile: { kind: 'ephemeral' } });

    // Acquired once, before the probe, and never re-acquired for the launch.
    expect(recorder.events.indexOf('reservation:acquire')).toBeLessThan(
      recorder.events.indexOf('compatibility:check'),
    );
    expect(recorder.events.filter((e) => e === 'reservation:acquire')).toHaveLength(1);
  });

  it('follows the startup sequence: resolve, reserve, verify, profile, launch', async () => {
    const { services } = makeServices(recorder, {
      resolution: { status: 'resolved', installation: managedInstallation() },
    });
    mockLaunch.mockResolvedValue(makeLaunched(recorder));
    const provider = new LocalBrowserProvider({
      profileStore: makeProfileStore(recorder),
      services,
      logger,
    });

    await provider.launch({ profile: { kind: 'ephemeral' } });

    expect(recorder.events).toEqual([
      'reservation:acquire',
      'compatibility:check',
      'profile:ephemeral',
    ]);
  });

  it('propagates a resolution failure without reserving or launching', async () => {
    const error = new BrowserResolutionError({
      code: 'missing',
      message: 'No Yantra-managed browser is installed.',
      requestedSelection: { source: 'managed', executablePath: null },
      remediation: 'Run `yantra browser install`.',
    });
    const { services } = makeServices(recorder, { resolution: { status: 'unavailable', error } });
    const provider = new LocalBrowserProvider({
      profileStore: makeProfileStore(recorder),
      services,
      logger,
    });

    await expect(provider.launch({ profile: { kind: 'ephemeral' } })).rejects.toBe(error);
    expect(services.coordinator.reserveUse).not.toHaveBeenCalled();
    expect(mockLaunch).not.toHaveBeenCalled();
  });

  it('refuses a capability failure before any profile or page exists', async () => {
    const installation = makeInstallation();
    const { services } = makeServices(recorder, { compatibility: failing(installation) });
    const provider = new LocalBrowserProvider({
      profileStore: makeProfileStore(recorder),
      services,
      logger,
    });

    const error = await provider
      .launch({ profile: { kind: 'ephemeral' } })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BrowserCompatibilityError);
    expect((error as Error).message).toContain('click-replace');
    // The refusal happens before a profile is created and before any launch.
    expect(recorder.events).not.toContain('profile:ephemeral');
    expect(mockLaunch).not.toHaveBeenCalled();
  });

  it('there is no readiness-bypass option on the launch surface', async () => {
    const installation = makeInstallation();
    const { services } = makeServices(recorder, { compatibility: failing(installation) });
    const provider = new LocalBrowserProvider({
      profileStore: makeProfileStore(recorder),
      services,
      logger,
    });

    await expect(
      provider.launch({
        profile: { kind: 'ephemeral' },
        // Any hopeful bypass flag is simply not part of the contract.
        ...({ skipCompatibilityCheck: true } as Record<string, unknown>),
      }),
    ).rejects.toBeInstanceOf(BrowserCompatibilityError);
  });

  it('releases the managed reservation when compatibility refuses the browser', async () => {
    const installation = managedInstallation();
    const { services } = makeServices(recorder, {
      resolution: { status: 'resolved', installation },
      compatibility: failing(installation),
    });
    const provider = new LocalBrowserProvider({
      profileStore: makeProfileStore(recorder),
      services,
      logger,
    });

    await expect(provider.launch({ profile: { kind: 'ephemeral' } })).rejects.toBeInstanceOf(
      BrowserCompatibilityError,
    );

    expect(recorder.events).toContain('reservation:never-spawned');
  });

  it('rolls the reservation back when the requested profile cannot be created', async () => {
    const { services } = makeServices(recorder, {
      resolution: { status: 'resolved', installation: managedInstallation() },
    });
    const provider = new LocalBrowserProvider({
      profileStore: makeProfileStore(recorder, {
        resolve: () => Promise.reject(new Error('profile directory is not writable')),
      }),
      services,
      logger,
    });

    await expect(provider.launch({ profile: { kind: 'ephemeral' } })).rejects.toThrow(
      /not writable/,
    );

    expect(recorder.events).toContain('reservation:never-spawned');
    expect(mockLaunch).not.toHaveBeenCalled();
  });

  it('removes the ephemeral profile it created when the launch fails afterwards', async () => {
    const { services } = makeServices(recorder);
    mockLaunch.mockRejectedValue(new Error('spawn failed'));
    const provider = new LocalBrowserProvider({
      profileStore: makeProfileStore(recorder),
      services,
      logger,
    });

    await expect(provider.launch({ profile: { kind: 'ephemeral' } })).rejects.toThrow(
      /spawn failed/,
    );

    expect(recorder.events).toContain('cleanup:/tmp/yantra-ephemeral');
  });

  it.each(['workflow', 'explicit'] as const)(
    'never deletes a %s profile when startup fails',
    async (kind) => {
      const { services } = makeServices(recorder);
      mockLaunch.mockRejectedValue(new Error('CDP initialization failed'));
      const provider = new LocalBrowserProvider({
        profileStore: makeProfileStore(recorder),
        services,
        logger,
      });

      await expect(
        provider.launch(
          kind === 'workflow'
            ? { profile: { kind: 'workflow', workflowName: 'invoices' } }
            : { profile: { kind: 'explicit', absolutePath: '/home/user/profiles/mine' } },
        ),
      ).rejects.toThrow();

      expect(recorder.events.some((event) => event.startsWith('cleanup:'))).toBe(false);
    },
  );

  it('surfaces a busy managed installation as a coordination error', async () => {
    const { services } = makeServices(recorder, {
      resolution: { status: 'resolved', installation: managedInstallation() },
      reserveError: new ManagedCoordinationError({
        reason: 'operation-in-progress',
        detail: 'An update is in progress.',
        remediation: 'Wait for it to finish, then retry.',
      }),
    });
    const provider = new LocalBrowserProvider({
      profileStore: makeProfileStore(recorder),
      services,
      logger,
    });

    await expect(provider.launch({ profile: { kind: 'ephemeral' } })).rejects.toBeInstanceOf(
      ManagedCoordinationError,
    );
    expect(mockLaunch).not.toHaveBeenCalled();
  });

  it('re-resolves and re-verifies when the executable changed between probe and launch', async () => {
    const original = makeInstallation();
    const replaced = makeInstallation({ version: '154.0.1.0', statFingerprint: 'new:stat' });
    const { services } = makeServices(recorder);
    vi.mocked(services.resolver.resolve)
      .mockResolvedValueOnce({ status: 'resolved', installation: original })
      .mockResolvedValueOnce({ status: 'resolved', installation: replaced });
    vi.mocked(resolverModule.identifyExecutable).mockResolvedValueOnce({
      canonicalPath: original.canonicalPath,
      version: '154.0.1.0',
      majorVersion: 154,
      platform: 'linux',
      architecture: 'x64',
      statFingerprint: 'new:stat',
    });
    mockLaunch.mockResolvedValue(makeLaunched(recorder));
    const provider = new LocalBrowserProvider({
      profileStore: makeProfileStore(recorder),
      services,
      logger,
    });

    await provider.launch({ profile: { kind: 'ephemeral' } });

    // Stale evidence is refused: the second build is verified before launch.
    expect(services.compatibility.check).toHaveBeenCalledTimes(2);
    expect(mockLaunch.mock.calls[0]![1]).toMatchObject({ version: '154.0.1.0' });
  });

  it('passes the invocation selection through to the resolver', async () => {
    const { services } = makeServices(recorder);
    mockLaunch.mockResolvedValue(makeLaunched(recorder));
    const provider = new LocalBrowserProvider({
      profileStore: makeProfileStore(recorder),
      services,
      logger,
    });

    await provider.launch({
      profile: { kind: 'ephemeral' },
      browserSelection: { source: 'managed', executablePath: null },
    });

    expect(services.resolver.resolve).toHaveBeenCalledWith({
      source: 'managed',
      executablePath: null,
    });
  });

  it('translates the legacy override into a system selection', async () => {
    const { services } = makeServices(recorder);
    mockLaunch.mockResolvedValue(makeLaunched(recorder));
    const provider = new LocalBrowserProvider({
      profileStore: makeProfileStore(recorder),
      services,
      logger,
    });

    await provider.launch({
      profile: { kind: 'ephemeral' },
      chromeOverridePath: '/opt/chrome/chrome',
    });

    expect(services.resolver.resolve).toHaveBeenCalledWith({
      source: 'system',
      executablePath: '/opt/chrome/chrome',
    });
  });

  it('never logs the profile path or launch arguments', async () => {
    const { services } = makeServices(recorder);
    mockLaunch.mockResolvedValue(makeLaunched(recorder));
    const infos: string[] = [];
    const provider = new LocalBrowserProvider({
      profileStore: makeProfileStore(recorder),
      services,
      logger: {
        ...logger,
        info: (obj, msg) => infos.push(`${JSON.stringify(obj)} ${msg ?? ''}`),
      },
    });

    await provider.launch({ profile: { kind: 'ephemeral' } });

    const combined = infos.join('\n');
    expect(combined).not.toContain('/tmp/yantra-ephemeral');
    expect(combined).not.toContain('--user-data-dir');
    // Selection provenance is what the log is for.
    expect(combined).toContain('"reason":"system-discovery"');
    expect(combined).toContain('"ownership":"external"');
  });
});

describe('@no-llm LocalBrowserProvider.detectChrome', () => {
  it('reports the browser the resolver would select', async () => {
    const recorder: Recorder = { events: [] };
    const { services } = makeServices(recorder, {
      resolution: { status: 'resolved', installation: managedInstallation() },
    });
    const provider = new LocalBrowserProvider({
      profileStore: makeProfileStore(recorder),
      services,
      logger,
    });

    await expect(provider.detectChrome()).resolves.toMatchObject({ source: 'managed' });
  });
});
