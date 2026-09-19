/**
 * What an agentic run can later say about the browser it used.
 *
 * The guarantee under test is that one successful task launch emits exactly one
 * complete `browser_ready` projection built from the *final* installation and
 * the *final* compatibility decision, that a cached launch and a fresh launch
 * describe the same browser with the same fields, and that a refusal at any
 * startup phase leaves one safe `browser_startup_failed` projection before
 * rollback — never the error's message, arguments, stderr, or paths.
 */

import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assertRuntimeEventIsSafe } from '@yantra/test-helpers';
import type { Browser } from 'puppeteer-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as resolverModule from '../../src/browser/browser-resolver.js';
import { CompatibilityCache } from '../../src/browser/compatibility-cache.js';
import {
  LocalBrowserCompatibilityService,
  type CapabilityRunner,
} from '../../src/browser/compatibility.js';
import { DRIVER_COMPATIBILITY, TESTED_BUILD } from '../../src/browser/driver-compatibility.js';
import {
  BrowserCompatibilityError,
  BrowserInstallOfferDeclinedError,
  BrowserLaunchError,
  BrowserManagedInstallError,
  BrowserProcessError,
  BrowserResolutionError,
  ManagedCoordinationError,
} from '../../src/browser/errors.js';
import type {
  BrowserReadyRuntimeEvent,
  BrowserRuntimeServices,
  BrowserStartupFailedRuntimeEvent,
  CapabilityId,
  ManagedReadyRecord,
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

/** The steady state: Stable ships ahead of the driver's tested pairing. */
const NEWER_THAN_TESTED = '153.0.8010.36';

/** Canaries planted in every field the projection must never reach for. */
const CANARIES = Object.freeze({
  stderr: 'CANARY-STDERR-9f2a',
  arg: '--canary-flag=CANARY-ARGV-4b71',
  detail: 'CANARY-DETAIL-c30d',
  profilePath: '/tmp/yantra-CANARY-PROFILE-1a2b',
  executablePath: '/home/canary-user/CANARY-EXEC-7e5f/chrome',
  remediation: 'CANARY-REMEDIATION-88aa',
});

const READY_RECORD: ManagedReadyRecord = {
  schemaVersion: 1,
  installationId: 'abc123',
  browser: 'chrome',
  platform: 'linux',
  buildId: NEWER_THAN_TESTED,
  cacheRootRelative: 'installation-abc123',
  executableRelative: 'chrome/linux-153.0.8010.36/chrome-linux64/chrome',
  verifiedAt: '2026-09-12T00:00:00.000Z',
};

function installation(
  overrides: Partial<ResolvedBrowserInstallation> = {},
): ResolvedBrowserInstallation {
  const version = overrides.version ?? NEWER_THAN_TESTED;
  return {
    canonicalPath: CANARIES.executablePath,
    version,
    majorVersion: Number.parseInt(version.split('.')[0]!, 10),
    platform: 'linux',
    architecture: 'x64',
    statFingerprint: `1:2:3:${version}`,
    ownership: 'external',
    requestedSelection: { source: 'auto', executablePath: null },
    selectionOrigin: 'default',
    selectionReason: 'system-discovery',
    channel: 'stable',
    managedIdentity: null,
    ...overrides,
  };
}

interface Emitted {
  readonly level: 'info' | 'warn' | 'error' | 'debug';
  readonly payload: Record<string, unknown>;
  readonly msg: string | undefined;
}

function recordingLogger(sink: Emitted[], trace: string[] = []): Logger {
  const at =
    (level: Emitted['level']) =>
    (obj: Record<string, unknown> | string, msg?: string): void => {
      const payload = typeof obj === 'string' ? { msg: obj } : obj;
      sink.push({ level, payload, msg });
      if (typeof payload.event === 'string') trace.push(`log:${payload.event}`);
    };
  return { info: at('info'), warn: at('warn'), error: at('error'), debug: at('debug') };
}

function readyEvents(sink: readonly Emitted[]): BrowserReadyRuntimeEvent[] {
  return sink
    .filter((entry) => entry.payload.event === 'browser_ready')
    .map((entry) => entry.payload as unknown as BrowserReadyRuntimeEvent);
}

function failureEvents(sink: readonly Emitted[]): Emitted[] {
  return sink.filter((entry) => entry.payload.event === 'browser_startup_failed');
}

function makeProfileStore(events: string[], resolveError?: Error): ProfileStore {
  return {
    resolve: (spec) => {
      events.push('profile:resolve');
      if (resolveError) return Promise.reject(resolveError);
      return Promise.resolve({
        absolutePath: CANARIES.profilePath,
        kind: spec.kind,
        createdNow: true,
      } satisfies ResolvedProfile);
    },
    listWorkflowProfiles: () => Promise.resolve([]),
    removeWorkflowProfile: () => Promise.resolve(),
    cleanupEphemeral: (path) => {
      events.push(`cleanup:${path}`);
      return Promise.resolve();
    },
  };
}

class FakeChild extends EventEmitter {
  pid: number | undefined = 4321;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stderr = null;
}

function makeLaunched(): OwnedBrowserProcess {
  return {
    browser: {
      on: vi.fn(),
      pages: () => Promise.resolve([]),
      newPage: () => Promise.resolve({ url: () => 'about:blank' }),
      close: () => Promise.resolve(),
    } as unknown as Browser,
    child: new FakeChild() as never,
    supervisor: {
      hasExited: () => false,
      whenExited: () => Promise.resolve(),
    } as unknown as BrowserProcessSupervisor,
    ownership: { kind: 'external' },
    shutdown: () => Promise.resolve(),
  };
}

/**
 * The real compatibility service over a real on-disk cache.
 *
 * Only the two genuine external boundaries are replaced — spawning a browser
 * and creating a profile directory — so cache validity, key material, probe
 * ordering, and the pairing decision are the production ones.
 */
function realCompatibility(
  cacheRoot: string,
  probeLaunches: { count: number },
  runners: Partial<Record<CapabilityId, CapabilityRunner>> = {},
): LocalBrowserCompatibilityService {
  return new LocalBrowserCompatibilityService({
    cache: new CompatibilityCache({ root: () => cacheRoot }),
    profileStore: {
      resolve: (spec) =>
        Promise.resolve({
          absolutePath: join(cacheRoot, 'probe-profile'),
          kind: spec.kind,
          createdNow: true,
        }),
      listWorkflowProfiles: () => Promise.resolve([]),
      removeWorkflowProfile: () => Promise.resolve(),
      cleanupEphemeral: () => Promise.resolve(),
    },
    capabilityRunners: {
      ...Object.fromEntries(
        DRIVER_COMPATIBILITY.capabilities.map((row) => [row.id, () => Promise.resolve()]),
      ),
      ...runners,
    } as Partial<Record<CapabilityId, CapabilityRunner>>,
    launch: (_options, _resolved, _profile, ownership) => {
      probeLaunches.count += 1;
      const owned: OwnedBrowserProcess = {
        browser: {
          version: () => Promise.resolve(`HeadlessChrome/${NEWER_THAN_TESTED}`),
          pages: () => Promise.resolve([]),
          newPage: () => Promise.reject(new Error('unused')),
          close: () => Promise.resolve(),
        } as unknown as Browser,
        child: { pid: 99 } as never,
        supervisor: { hasExited: () => true } as unknown as BrowserProcessSupervisor,
        ownership,
        shutdown: () => Promise.resolve(),
      };
      return Promise.resolve(owned);
    },
  });
}

interface Harness {
  readonly services: BrowserRuntimeServices;
  readonly reservation: OwnedManagedUseReservation;
  readonly events: string[];
}

function makeServices(
  compatibility: LocalBrowserCompatibilityService,
  opts: {
    resolutions?: readonly ResolvedBrowserInstallation[];
    resolutionError?: Error;
    reserveError?: Error;
  } = {},
): Harness {
  const events: string[] = [];
  const queue = [...(opts.resolutions ?? [installation()])];
  const reservation: OwnedManagedUseReservation = {
    id: 'res-1',
    installationId: 'abc123',
    phase: 'starting',
    attachChild: () => Promise.resolve(),
    releaseAfterExit: () => Promise.resolve(),
    markNeverSpawned: () => {
      events.push('reservation:never-spawned');
      return Promise.resolve();
    },
  };
  return {
    events,
    reservation,
    services: {
      resolver: {
        resolve: vi.fn(() => {
          if (opts.resolutionError) {
            return Promise.resolve({
              status: 'unavailable' as const,
              error: opts.resolutionError as BrowserResolutionError,
            });
          }
          const next = queue.length > 1 ? queue.shift()! : queue[0]!;
          return Promise.resolve({ status: 'resolved' as const, installation: next });
        }),
      },
      compatibility,
      coordinator: {
        reserveUse: vi.fn(() =>
          opts.reserveError ? Promise.reject(opts.reserveError) : Promise.resolve(reservation),
        ),
        claimMutation: vi.fn(),
        hasActiveUse: vi.fn().mockResolvedValue(false),
      },
      managedState: {
        readReady: vi.fn().mockResolvedValue({ status: 'ready', record: READY_RECORD }),
        readInventory: vi
          .fn()
          .mockResolvedValue({ ready: { status: 'ready', record: READY_RECORD }, orphans: [] }),
      },
    },
  };
}

describe('@no-llm browser_ready runtime projection', () => {
  let cacheRoot: string;
  let sink: Emitted[];
  let probeLaunches: { count: number };

  beforeEach(async () => {
    vi.clearAllMocks();
    LocalBrowserProvider.resetInstallOfferForTests();
    cacheRoot = await mkdtemp(join(tmpdir(), 'yantra-ready-'));
    sink = [];
    probeLaunches = { count: 0 };
    vi.spyOn(resolverModule, 'identifyExecutable').mockImplementation((path) =>
      Promise.resolve({
        canonicalPath: path,
        version: NEWER_THAN_TESTED,
        majorVersion: 153,
        platform: 'linux',
        architecture: 'x64',
        statFingerprint: `1:2:3:${NEWER_THAN_TESTED}`,
      }),
    );
    mockLaunch.mockResolvedValue(makeLaunched());
  });

  afterEach(async () => {
    await rm(cacheRoot, { recursive: true, force: true });
  });

  function buildProvider(harness: Harness) {
    return new LocalBrowserProvider({
      profileStore: makeProfileStore(harness.events),
      services: harness.services,
      logger: recordingLogger(sink, harness.events),
    });
  }

  it('emits exactly one complete event from cached evidence, without probing', async () => {
    const compatibility = realCompatibility(cacheRoot, probeLaunches);
    // Seed the real cache the way an earlier run would have.
    await compatibility.check(installation(), { profile: 'automation', fresh: true });
    probeLaunches.count = 0;
    const harness = makeServices(compatibility);

    await buildProvider(harness).launch({ profile: { kind: 'ephemeral' } });

    const ready = readyEvents(sink);
    expect(ready).toHaveLength(1);
    expect(probeLaunches.count).toBe(0);
    expect(ready[0]).toMatchObject({
      schema_version: 1,
      event: 'browser_ready',
      selection_source: 'auto',
      selection_origin: 'default',
      selection_reason: 'system-discovery',
      ownership: 'external',
      browser_version: NEWER_THAN_TESTED,
      executable_basename: 'chrome',
      driver_version: DRIVER_COMPATIBILITY.driverVersion,
      tested_build: TESTED_BUILD,
      probe_revision: DRIVER_COMPATIBILITY.probeRevision,
      probe_profile: 'automation',
      compatibility_verdict: 'passed',
      pairing: 'capability-checked',
      evidence_source: 'cache',
    });
    expect(ready[0]!.executable_path_sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(Date.parse(ready[0]!.evidence_checked_at)).not.toBeNaN();
  });

  it('describes a fresh launch with the same fields a cached launch reports', async () => {
    const fresh = realCompatibility(cacheRoot, probeLaunches);
    const freshHarness = makeServices(fresh);
    await buildProvider(freshHarness).launch({ profile: { kind: 'ephemeral' } });
    const freshEvent = readyEvents(sink)[0]!;
    const freshProbes = probeLaunches.count;

    sink = [];
    const cached = realCompatibility(cacheRoot, probeLaunches);
    const cachedHarness = makeServices(cached);
    await buildProvider(cachedHarness).launch({ profile: { kind: 'ephemeral' } });
    const cachedEvent = readyEvents(sink)[0]!;

    expect(freshProbes).toBe(1);
    expect(probeLaunches.count).toBe(1);
    expect(freshEvent.evidence_source).toBe('probe');
    expect(cachedEvent.evidence_source).toBe('cache');
    // Same shape, same browser, same verdict: only provenance and check time
    // may legitimately differ.
    expect(Object.keys(cachedEvent).sort()).toEqual(Object.keys(freshEvent).sort());
    const { evidence_source: _fs, evidence_checked_at: _fc, ...freshRest } = freshEvent;
    const { evidence_source: _cs, evidence_checked_at: _cc, ...cachedRest } = cachedEvent;
    expect(cachedRest).toEqual(freshRest);
  });

  it.each([
    [TESTED_BUILD, 'tested'],
    [NEWER_THAN_TESTED, 'capability-checked'],
  ])('reports the %s pairing as ordinary INFO provenance', async (version, pairing) => {
    const compatibility = realCompatibility(cacheRoot, probeLaunches);
    const target = installation({ version });
    const harness = makeServices(compatibility, { resolutions: [target] });
    vi.mocked(resolverModule.identifyExecutable).mockResolvedValue({
      canonicalPath: target.canonicalPath,
      version,
      majorVersion: target.majorVersion,
      platform: 'linux',
      architecture: 'x64',
      statFingerprint: target.statFingerprint,
    });

    await buildProvider(harness).launch({ profile: { kind: 'ephemeral' } });

    const entry = sink.find((e) => e.payload.event === 'browser_ready')!;
    expect(entry.level).toBe('info');
    expect(entry.payload.pairing).toBe(pairing);
    // A capability-checked pairing is the steady state, never a warning.
    expect(sink.filter((e) => e.level === 'warn' || e.level === 'error')).toEqual([]);
  });

  it('logs only the revalidated identity when the executable changed mid-startup', async () => {
    const original = installation();
    const replaced = installation({
      version: '154.0.1.0',
      canonicalPath: '/opt/replacement/chrome',
      statFingerprint: 'new:stat',
    });
    const compatibility = realCompatibility(cacheRoot, probeLaunches);
    const harness = makeServices(compatibility, { resolutions: [original, replaced] });
    // The binary on disk is the replacement by the time the provider re-stats.
    vi.mocked(resolverModule.identifyExecutable).mockResolvedValue({
      canonicalPath: original.canonicalPath,
      version: '154.0.1.0',
      majorVersion: 154,
      platform: 'linux',
      architecture: 'x64',
      statFingerprint: 'new:stat',
    });

    await buildProvider(harness).launch({ profile: { kind: 'ephemeral' } });

    const ready = readyEvents(sink);
    expect(ready).toHaveLength(1);
    expect(ready[0]!.browser_version).toBe('154.0.1.0');
    expect(ready[0]!.executable_basename).toBe('chrome');
    // The replacement was probed on its own evidence, so provenance says probe.
    expect(ready[0]!.evidence_source).toBe('probe');
    expect(mockLaunch.mock.calls[0]![1]).toMatchObject({ version: '154.0.1.0' });
  });

  it('identifies the same binary by hash and a different one by a different hash', async () => {
    const compatibility = realCompatibility(cacheRoot, probeLaunches);
    const first = makeServices(compatibility);
    await buildProvider(first).launch({ profile: { kind: 'ephemeral' } });
    const same = makeServices(compatibility);
    await buildProvider(same).launch({ profile: { kind: 'ephemeral' } });

    const other = installation({ canonicalPath: '/opt/other/chrome' });
    const otherHarness = makeServices(compatibility, { resolutions: [other] });
    await buildProvider(otherHarness).launch({ profile: { kind: 'ephemeral' } });

    const hashes = readyEvents(sink).map((event) => event.executable_path_sha256);
    expect(hashes).toHaveLength(3);
    expect(hashes[0]).toBe(hashes[1]);
    expect(hashes[2]).not.toBe(hashes[0]);
  });

  it('never carries a path, an argument, an error message, or a canary', async () => {
    const compatibility = realCompatibility(cacheRoot, probeLaunches);
    const harness = makeServices(compatibility);

    await buildProvider(harness).launch({ profile: { kind: 'ephemeral' } });

    for (const event of readyEvents(sink)) {
      assertRuntimeEventIsSafe(event, Object.values(CANARIES));
    }
  });
});

describe('@no-llm browser_startup_failed runtime projection', () => {
  let cacheRoot: string;
  let sink: Emitted[];
  let probeLaunches: { count: number };

  beforeEach(async () => {
    vi.clearAllMocks();
    LocalBrowserProvider.resetInstallOfferForTests();
    cacheRoot = await mkdtemp(join(tmpdir(), 'yantra-startup-fail-'));
    sink = [];
    probeLaunches = { count: 0 };
    vi.spyOn(resolverModule, 'identifyExecutable').mockImplementation((path) =>
      Promise.resolve({
        canonicalPath: path,
        version: NEWER_THAN_TESTED,
        majorVersion: 153,
        platform: 'linux',
        architecture: 'x64',
        statFingerprint: `1:2:3:${NEWER_THAN_TESTED}`,
      }),
    );
  });

  afterEach(async () => {
    await rm(cacheRoot, { recursive: true, force: true });
  });

  async function expectOneFailure(
    harness: Harness,
    expected: Partial<BrowserStartupFailedRuntimeEvent>,
    thrown: unknown,
  ): Promise<void> {
    const provider = new LocalBrowserProvider({
      profileStore: makeProfileStore(harness.events),
      services: harness.services,
      logger: recordingLogger(sink, harness.events),
    });

    const error = await provider
      .launch({ profile: { kind: 'ephemeral' } })
      .catch((e: unknown) => e);

    // The original error reaches the caller untouched; only the projection is
    // sanitized. A surface that renders remediation still can.
    expect(error).toBe(thrown);
    const emitted = failureEvents(sink);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.payload).toMatchObject(expected as Record<string, unknown>);
    assertRuntimeEventIsSafe(emitted[0]!.payload, Object.values(CANARIES));
    // Emitted before rollback: an operator reading the log sees the refusal
    // ahead of the cleanup and reservation release it caused. Both halves share
    // one ordered trace, so this compares real positions rather than two lists.
    const failureIndex = harness.events.indexOf('log:browser_startup_failed');
    expect(failureIndex).toBeGreaterThanOrEqual(0);
    for (const rollback of ['cleanup:', 'reservation:never-spawned']) {
      const at = harness.events.findIndex((e) => e.startsWith(rollback));
      if (at >= 0) expect(at).toBeGreaterThan(failureIndex);
    }
  }

  it('classifies a resolution refusal', async () => {
    const thrown = new BrowserResolutionError({
      code: 'invalid-executable',
      message: `The browser at ${CANARIES.executablePath} is unusable.`,
      requestedSelection: { source: 'system', executablePath: CANARIES.executablePath },
      remediation: CANARIES.remediation,
    });
    const compatibility = realCompatibility(cacheRoot, probeLaunches);
    const harness = makeServices(compatibility, { resolutionError: thrown });

    await expectOneFailure(
      harness,
      {
        schema_version: 1,
        event: 'browser_startup_failed',
        phase: 'resolution',
        error_class: 'BrowserResolutionError',
        failure_kind: 'resolution',
        resolution_code: 'invalid-executable',
      },
      thrown,
    );
  });

  it('classifies a managed coordination refusal at the reservation phase', async () => {
    const thrown = new ManagedCoordinationError({
      reason: 'operation-in-progress',
      detail: CANARIES.detail,
      remediation: CANARIES.remediation,
    });
    const compatibility = realCompatibility(cacheRoot, probeLaunches);
    const harness = makeServices(compatibility, {
      resolutions: [installation({ ownership: 'managed', managedIdentity: READY_RECORD })],
      reserveError: thrown,
    });

    await expectOneFailure(
      harness,
      {
        phase: 'reservation',
        error_class: 'ManagedCoordinationError',
        failure_kind: 'coordination',
        coordination_reason: 'operation-in-progress',
      },
      thrown,
    );
  });

  it('classifies a capability failure at the compatibility phase', async () => {
    const compatibility = realCompatibility(cacheRoot, probeLaunches, {
      'click-replace': () => Promise.reject(new Error(`appended ${CANARIES.detail}`)),
    });
    const harness = makeServices(compatibility);
    const provider = new LocalBrowserProvider({
      profileStore: makeProfileStore(harness.events),
      services: harness.services,
      logger: recordingLogger(sink),
    });

    const error = await provider
      .launch({ profile: { kind: 'ephemeral' } })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BrowserCompatibilityError);
    const emitted = failureEvents(sink);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.payload).toMatchObject({
      phase: 'compatibility',
      error_class: 'BrowserCompatibilityError',
      failure_kind: 'compatibility',
      compatibility_failure_class: 'capability-failure',
      compatibility_profile: 'automation',
    });
    assertRuntimeEventIsSafe(emitted[0]!.payload, Object.values(CANARIES));
    // No profile was created, so nothing about the user's disk is in play.
    expect(harness.events).not.toContain('profile:resolve');
  });

  it('classifies a profile-creation failure and still cleans up', async () => {
    const thrown = new Error(`profile refused at ${CANARIES.profilePath}`);
    const compatibility = realCompatibility(cacheRoot, probeLaunches);
    const harness = makeServices(compatibility);
    const provider = new LocalBrowserProvider({
      profileStore: makeProfileStore(harness.events, thrown),
      services: harness.services,
      logger: recordingLogger(sink),
    });

    await expect(provider.launch({ profile: { kind: 'ephemeral' } })).rejects.toBe(thrown);

    const emitted = failureEvents(sink);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.payload).toMatchObject({
      phase: 'profile',
      error_class: 'Error',
      failure_kind: 'unexpected',
    });
    assertRuntimeEventIsSafe(emitted[0]!.payload, Object.values(CANARIES));
  });

  it('classifies a missing binary at the identity-revalidation phase', async () => {
    const compatibility = realCompatibility(cacheRoot, probeLaunches);
    const harness = makeServices(compatibility);
    vi.mocked(resolverModule.identifyExecutable).mockResolvedValue(null);
    const provider = new LocalBrowserProvider({
      profileStore: makeProfileStore(harness.events),
      services: harness.services,
      logger: recordingLogger(sink),
    });

    await expect(provider.launch({ profile: { kind: 'ephemeral' } })).rejects.toThrow();

    const emitted = failureEvents(sink);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.payload).toMatchObject({
      phase: 'identity-revalidation',
      error_class: 'ChromeNotFoundError',
      failure_kind: 'resolution',
      resolution_code: 'missing',
    });
    assertRuntimeEventIsSafe(emitted[0]!.payload, Object.values(CANARIES));
  });

  it('classifies a launch failure without its arguments or stderr', async () => {
    const thrown = new BrowserLaunchError({
      phase: 'spawn',
      lastStderr: CANARIES.stderr,
      args: [CANARIES.arg, `--user-data-dir=${CANARIES.profilePath}`],
    });
    const compatibility = realCompatibility(cacheRoot, probeLaunches);
    const harness = makeServices(compatibility);
    mockLaunch.mockRejectedValue(thrown);

    await expectOneFailure(
      harness,
      {
        phase: 'launch',
        error_class: 'BrowserLaunchError',
        failure_kind: 'launch',
        launch_phase: 'spawn',
      },
      thrown,
    );
    expect(failureEvents(sink)[0]!.level).toBe('error');
  });

  it('classifies a process failure and preserves exit_proven', async () => {
    const thrown = new BrowserProcessError({
      phase: 'settle',
      detail: CANARIES.detail,
      exitProven: false,
    });
    const compatibility = realCompatibility(cacheRoot, probeLaunches);
    const harness = makeServices(compatibility);
    mockLaunch.mockRejectedValue(thrown);

    await expectOneFailure(
      harness,
      {
        phase: 'launch',
        error_class: 'BrowserProcessError',
        failure_kind: 'process',
        process_phase: 'settle',
        exit_proven: false,
      },
      thrown,
    );
  });

  it('classifies a declined install offer as a user handoff, not a fault', async () => {
    const missing = new BrowserResolutionError({
      code: 'missing',
      message: 'No browser is available.',
      requestedSelection: { source: 'auto', executablePath: null },
      remediation: CANARIES.remediation,
    });
    const compatibility = realCompatibility(cacheRoot, probeLaunches);
    const harness = makeServices(compatibility, { resolutionError: missing });
    const provider = new LocalBrowserProvider({
      profileStore: makeProfileStore(harness.events),
      services: harness.services,
      logger: recordingLogger(sink),
      installOfferGateway: { offer: vi.fn().mockResolvedValue(null) },
      installService: { install: vi.fn(), collectOrphans: vi.fn() },
    });

    await expect(provider.launch({ profile: { kind: 'ephemeral' } })).rejects.toBeInstanceOf(
      BrowserInstallOfferDeclinedError,
    );

    const emitted = failureEvents(sink);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.level).toBe('warn');
    expect(emitted[0]!.payload).toMatchObject({
      phase: 'resolution',
      error_class: 'BrowserInstallOfferDeclinedError',
      failure_kind: 'install-declined',
    });
    assertRuntimeEventIsSafe(emitted[0]!.payload, Object.values(CANARIES));
  });

  it('classifies a failed consented install by its code and phase only', async () => {
    const missing = new BrowserResolutionError({
      code: 'missing',
      message: 'No browser is available.',
      requestedSelection: { source: 'auto', executablePath: null },
      remediation: CANARIES.remediation,
    });
    const compatibility = realCompatibility(cacheRoot, probeLaunches);
    const harness = makeServices(compatibility, { resolutionError: missing });
    const provider = new LocalBrowserProvider({
      profileStore: makeProfileStore(harness.events),
      services: harness.services,
      logger: recordingLogger(sink),
      installOfferGateway: {
        offer: vi.fn().mockResolvedValue({ accepted: true, source: 'interactive-offer' }),
      },
      installService: {
        install: vi.fn().mockResolvedValue({
          status: 'failed',
          error: {
            code: 'network-failure',
            phase: 'downloading',
            detail: CANARIES.detail,
            remediation: CANARIES.remediation,
            retainedOrphan: null,
          },
        }),
        collectOrphans: vi.fn(),
      },
    });

    await expect(provider.launch({ profile: { kind: 'ephemeral' } })).rejects.toBeInstanceOf(
      BrowserManagedInstallError,
    );

    const emitted = failureEvents(sink);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.payload).toMatchObject({
      phase: 'resolution',
      error_class: 'BrowserManagedInstallError',
      failure_kind: 'managed-install',
      install_code: 'network-failure',
      install_phase: 'downloading',
    });
    assertRuntimeEventIsSafe(emitted[0]!.payload, Object.values(CANARIES));
  });

  it('emits no ready event at all when startup refuses', async () => {
    const thrown = new BrowserLaunchError({
      phase: 'connect',
      lastStderr: CANARIES.stderr,
      args: [CANARIES.arg],
    });
    const compatibility = realCompatibility(cacheRoot, probeLaunches);
    const harness = makeServices(compatibility);
    mockLaunch.mockRejectedValue(thrown);
    const provider = new LocalBrowserProvider({
      profileStore: makeProfileStore(harness.events),
      services: harness.services,
      logger: recordingLogger(sink),
    });

    await expect(provider.launch({ profile: { kind: 'ephemeral' } })).rejects.toBe(thrown);

    // The ready event is emitted immediately before the launch call, so a
    // failing launch legitimately has one — what must not exist is a *second*
    // ready event, or a ready event with no launch attempt behind it.
    expect(readyEvents(sink).length).toBeLessThanOrEqual(1);
    expect(failureEvents(sink)).toHaveLength(1);
  });
});
