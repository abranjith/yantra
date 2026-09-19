import { EventEmitter } from 'node:events';

import type { Browser } from 'puppeteer-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as resolverModule from '../../src/browser/browser-resolver.js';
import {
  BrowserCompatibilityError,
  BrowserInstallOfferDeclinedError,
  BrowserLaunchError,
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
    evidenceSource?: 'cache' | 'probe';
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
      decide: vi.fn((installation: ResolvedBrowserInstallation) => {
        recorder.events.push('compatibility:check');
        return Promise.resolve({
          result: opts.compatibility ?? passing(installation),
          evidenceSource: opts.evidenceSource ?? ('probe' as const),
        });
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
    LocalBrowserProvider.resetInstallOfferForTests();
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

  it('offers once for an automatic missing browser, installs, re-resolves, and resumes launch', async () => {
    const missing = new BrowserResolutionError({
      code: 'missing',
      message: 'No browser is available.',
      requestedSelection: { source: 'auto', executablePath: null },
      remediation: 'Run `yantra browser install`.',
    });
    const { services } = makeServices(recorder);
    vi.mocked(services.resolver.resolve)
      .mockResolvedValueOnce({ status: 'unavailable', error: missing })
      .mockResolvedValueOnce({ status: 'resolved', installation: makeInstallation() });
    const gateway = {
      offer: vi.fn().mockResolvedValue({ accepted: true, source: 'interactive-offer' }),
    };
    const install = vi.fn().mockResolvedValue({
      status: 'already-installed',
      record: READY_RECORD,
      executablePath: '/managed/chrome',
      compatibility: { state: 'unverified' },
      orphans: { attempted: 0, deleted: 0, bytesReclaimed: 0, skippedLiveOwner: 0, failed: [] },
      updateCommand: 'yantra browser update',
    });
    mockLaunch.mockResolvedValue(makeLaunched(recorder));
    const provider = new LocalBrowserProvider({
      profileStore: makeProfileStore(recorder),
      services,
      logger,
      installOfferGateway: gateway,
      installService: { install, collectOrphans: vi.fn() },
    });

    await provider.launch({ profile: { kind: 'ephemeral' } });

    expect(gateway.offer).toHaveBeenCalledOnce();
    expect(install).toHaveBeenCalledOnce();
    expect(services.resolver.resolve).toHaveBeenCalledTimes(2);
    expect(mockLaunch).toHaveBeenCalledOnce();
  });

  it('serializes concurrent automatic sessions through one offer and one install', async () => {
    const missing = new BrowserResolutionError({
      code: 'missing',
      message: 'No browser is available.',
      requestedSelection: { source: 'auto', executablePath: null },
      remediation: 'Run `yantra browser install`.',
    });
    const first = makeServices(recorder);
    const second = makeServices(recorder);
    for (const services of [first.services, second.services]) {
      vi.mocked(services.resolver.resolve)
        .mockResolvedValueOnce({ status: 'unavailable', error: missing })
        .mockResolvedValueOnce({ status: 'resolved', installation: makeInstallation() });
    }
    let accept!: () => void;
    const decision = new Promise<{ accepted: true; source: 'interactive-offer' }>((resolve) => {
      accept = () => resolve({ accepted: true, source: 'interactive-offer' });
    });
    const gateway = { offer: vi.fn().mockReturnValue(decision) };
    const install = vi.fn().mockResolvedValue({
      status: 'already-installed',
      record: READY_RECORD,
      executablePath: '/managed/chrome',
      compatibility: { state: 'unverified' },
      orphans: {
        attempted: 0,
        deleted: 0,
        bytesReclaimed: 0,
        skippedLiveOwner: 0,
        failed: [],
      },
      updateCommand: 'yantra browser update',
    });
    mockLaunch.mockResolvedValue(makeLaunched(recorder));
    const providerOne = new LocalBrowserProvider({
      profileStore: makeProfileStore(recorder),
      services: first.services,
      logger,
      installOfferGateway: gateway,
      installService: { install, collectOrphans: vi.fn() },
    });
    const providerTwo = new LocalBrowserProvider({
      profileStore: makeProfileStore(recorder),
      services: second.services,
      logger,
      installOfferGateway: gateway,
      installService: { install, collectOrphans: vi.fn() },
    });

    const launches = [
      providerOne.launch({ profile: { kind: 'ephemeral' } }),
      providerTwo.launch({ profile: { kind: 'ephemeral' } }),
    ];
    await vi.waitFor(() => expect(gateway.offer).toHaveBeenCalledOnce());
    accept();
    await Promise.all(launches);

    expect(install).toHaveBeenCalledOnce();
    expect(first.services.resolver.resolve).toHaveBeenCalledTimes(2);
    expect(second.services.resolver.resolve).toHaveBeenCalledTimes(2);
    expect(mockLaunch).toHaveBeenCalledTimes(2);
  });

  it('turns a declined automatic offer into a user-handoff error without downloading', async () => {
    const missing = new BrowserResolutionError({
      code: 'missing',
      message: 'No browser is available.',
      requestedSelection: { source: 'auto', executablePath: null },
      remediation: 'Run `yantra browser install`.',
    });
    const { services } = makeServices(recorder, {
      resolution: { status: 'unavailable', error: missing },
    });
    const install = vi.fn();
    const provider = new LocalBrowserProvider({
      profileStore: makeProfileStore(recorder),
      services,
      logger,
      installOfferGateway: { offer: vi.fn().mockResolvedValue(null) },
      installService: { install, collectOrphans: vi.fn() },
    });

    await expect(provider.launch({ profile: { kind: 'ephemeral' } })).rejects.toBeInstanceOf(
      BrowserInstallOfferDeclinedError,
    );
    expect(install).not.toHaveBeenCalled();
  });

  it('never offers for an explicitly missing managed selection', async () => {
    const missing = new BrowserResolutionError({
      code: 'missing',
      message: 'Managed Chrome is absent.',
      requestedSelection: { source: 'managed', executablePath: null },
      remediation: 'Run `yantra browser install`.',
    });
    const { services } = makeServices(recorder, {
      resolution: { status: 'unavailable', error: missing },
    });
    const gateway = { offer: vi.fn() };
    const provider = new LocalBrowserProvider({
      profileStore: makeProfileStore(recorder),
      services,
      logger,
      selection: { source: 'managed', executablePath: null },
      installOfferGateway: gateway,
    });

    await expect(provider.launch({ profile: { kind: 'ephemeral' } })).rejects.toBe(missing);
    expect(gateway.offer).not.toHaveBeenCalled();
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

    // The options surface is strict, so a hopeful bypass flag cannot even be
    // spelled — it is rejected as an unknown option rather than ignored.
    await expect(
      provider.launch({
        profile: { kind: 'ephemeral' },
        ...({ skipCompatibilityCheck: true } as Record<string, unknown>),
      }),
    ).rejects.toBeInstanceOf(BrowserLaunchError);
    expect(services.compatibility.check).not.toHaveBeenCalled();

    // And with a valid options object the compatibility gate still refuses.
    await expect(provider.launch({ profile: { kind: 'ephemeral' } })).rejects.toBeInstanceOf(
      BrowserCompatibilityError,
    );
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
    expect(services.compatibility.decide).toHaveBeenCalledTimes(2);
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

  it('passes a custom executable through as one system selection', async () => {
    const { services } = makeServices(recorder);
    mockLaunch.mockResolvedValue(makeLaunched(recorder));
    const provider = new LocalBrowserProvider({
      profileStore: makeProfileStore(recorder),
      services,
      logger,
    });

    await provider.launch({
      profile: { kind: 'ephemeral' },
      browserSelection: { source: 'system', executablePath: '/opt/chrome/chrome' },
    });

    expect(services.resolver.resolve).toHaveBeenCalledWith({
      source: 'system',
      executablePath: '/opt/chrome/chrome',
    });
  });

  it('rejects the removed legacy override key rather than ignoring it', async () => {
    const { services } = makeServices(recorder);
    mockLaunch.mockResolvedValue(makeLaunched(recorder));
    const provider = new LocalBrowserProvider({
      profileStore: makeProfileStore(recorder),
      services,
      logger,
    });

    // Strict options: a caller still passing the old field is told so rather
    // than silently getting whatever the resolver would have picked anyway.
    await expect(
      provider.launch({
        profile: { kind: 'ephemeral' },
        chromeOverridePath: '/opt/chrome/chrome',
      } as never),
    ).rejects.toThrow();
    expect(services.resolver.resolve).not.toHaveBeenCalled();
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
    // Nor the full executable path: the binary is named by basename + hash.
    expect(combined).not.toContain('/usr/bin/google-chrome');
    // Selection provenance is what the log is for.
    expect(combined).toContain('"selection_reason":"system-discovery"');
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
