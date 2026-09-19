import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Browser } from 'puppeteer-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { CompatibilityCache } from '../../src/browser/compatibility-cache.js';
import {
  LocalBrowserCompatibilityService,
  parseDebDeps,
  type CapabilityRunner,
  type ProbeContext,
} from '../../src/browser/compatibility.js';
import {
  DRIVER_COMPATIBILITY,
  TESTED_BUILD,
  capabilityTableHash,
  cftPlatformFor,
  pairingFor,
  requiredCapabilities,
} from '../../src/browser/driver-compatibility.js';
import type {
  CapabilityId,
  ProbeProfile,
  ResolvedBrowserInstallation,
} from '../../src/browser/installation-types.js';
import type { OwnedBrowserProcess } from '../../src/browser/launcher.js';
import type { BrowserProcessSupervisor } from '../../src/browser/process-lifecycle.js';
import type { ProfileStore, ResolvedProfile } from '../../src/browser/types.js';
import { beginMigrationBrowserFixture } from '../helpers/migration-browser.js';

/** A build *newer* than the tested pairing — the steady state, not an exception. */
const NEWER_THAN_TESTED = '153.0.8010.36';

function installation(version = NEWER_THAN_TESTED): ResolvedBrowserInstallation {
  return {
    canonicalPath: '/opt/chrome/chrome',
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
  };
}

interface Harness {
  readonly service: LocalBrowserCompatibilityService;
  readonly profileStore: ProfileStore & {
    readonly resolved: ResolvedProfile[];
    readonly cleaned: string[];
  };
  readonly launchConfigs: unknown[];
  readonly closes: () => number;
  readonly shutdowns: () => number;
}

function makeProfileStore() {
  const resolved: ResolvedProfile[] = [];
  const cleaned: string[] = [];
  const store: ProfileStore & { resolved: ResolvedProfile[]; cleaned: string[] } = {
    resolved,
    cleaned,
    resolve: (spec) => {
      const profile: ResolvedProfile = {
        absolutePath: `/tmp/yantra-probe-${resolved.length}`,
        kind: spec.kind,
        createdNow: true,
      };
      resolved.push(profile);
      return Promise.resolve(profile);
    },
    listWorkflowProfiles: () => Promise.resolve([]),
    removeWorkflowProfile: () => Promise.resolve(),
    cleanupEphemeral: (path) => {
      cleaned.push(path);
      return Promise.resolve();
    },
  };
  return store;
}

function makeHarness(
  opts: {
    runners?: Partial<Record<CapabilityId, CapabilityRunner>>;
    launchError?: Error;
    debDeps?: string | null;
    cacheRoot?: string;
    shutdownError?: Error;
    cleanupError?: Error;
  } = {},
): Harness {
  const profileStore = makeProfileStore();
  if (opts.cleanupError) {
    profileStore.cleanupEphemeral = (path) => {
      profileStore.cleaned.push(path);
      return Promise.reject(opts.cleanupError!);
    };
  }
  const launchConfigs: unknown[] = [];
  let closes = 0;
  let shutdowns = 0;

  const service = new LocalBrowserCompatibilityService({
    profileStore,
    cache: new CompatibilityCache({
      root: () => opts.cacheRoot ?? join(tmpdir(), 'yantra-compat-unused'),
    }),
    readDebDeps: () => Promise.resolve(opts.debDeps ?? null),
    // Only the runners a test names are replaced; every other row is a pass.
    capabilityRunners: {
      ...Object.fromEntries(
        DRIVER_COMPATIBILITY.capabilities.map((row) => [row.id, () => Promise.resolve()]),
      ),
      ...opts.runners,
    } as Partial<Record<CapabilityId, CapabilityRunner>>,
    launch: (options, resolved, profile, ownership) => {
      launchConfigs.push({ options, resolved, profile, ownership });
      if (opts.launchError) return Promise.reject(opts.launchError);
      const browser = {
        version: () => Promise.resolve('HeadlessChrome/153.0.8010.36'),
        pages: () => Promise.resolve([]),
        newPage: () => Promise.reject(new Error('unused in this harness')),
        close: () => {
          closes += 1;
          return Promise.resolve();
        },
      } as unknown as Browser;
      const owned: OwnedBrowserProcess = {
        browser,
        child: { pid: 1 } as never,
        supervisor: { hasExited: () => true } as unknown as BrowserProcessSupervisor,
        ownership,
        shutdown: () => {
          shutdowns += 1;
          return opts.shutdownError ? Promise.reject(opts.shutdownError) : Promise.resolve();
        },
      };
      return Promise.resolve(owned);
    },
  });

  return { service, profileStore, launchConfigs, closes: () => closes, shutdowns: () => shutdowns };
}

describe('@no-llm driver compatibility descriptor', () => {
  it('records the tested pairing as a baseline, not a floor', () => {
    expect(DRIVER_COMPATIBILITY.testedBuild).toBe(TESTED_BUILD);
    expect(pairingFor(TESTED_BUILD)).toBe('tested');
    expect(pairingFor(NEWER_THAN_TESTED)).toBe('capability-checked');
    // An older build is capability-checked too — allowed, not rejected outright.
    expect(pairingFor('118.0.5993.70')).toBe('capability-checked');
  });

  it('requires the automation set plus three more rows for the recorder', () => {
    const automation = requiredCapabilities('automation').map((row) => row.id);
    const recorder = requiredCapabilities('recorder').map((row) => row.id);

    expect(recorder).toEqual(expect.arrayContaining(automation));
    expect(recorder.filter((id) => !automation.includes(id))).toEqual([
      'recorder-binding',
      'recorder-preload',
      'recorder-page-domain',
    ]);
  });

  it('orders rows so every prerequisite precedes its dependents', () => {
    const ordered = requiredCapabilities('recorder');
    const seen = new Set<CapabilityId>();
    for (const row of ordered) {
      for (const dependency of row.dependsOn) {
        if (ordered.some((candidate) => candidate.id === dependency)) {
          expect(seen.has(dependency)).toBe(true);
        }
      }
      seen.add(row.id);
    }
  });

  it('gives every row a rationale and at least one consuming caller', () => {
    for (const row of DRIVER_COMPATIBILITY.capabilities) {
      expect(row.why.length).toBeGreaterThan(10);
      expect(row.requiredBy.length).toBeGreaterThan(0);
    }
  });

  it('maps supported hosts and refuses unsupported ones', () => {
    expect(cftPlatformFor('linux', 'x64')).toBe('linux');
    expect(cftPlatformFor('darwin', 'arm64')).toBe('mac_arm');
    expect(cftPlatformFor('win32', 'x64')).toBe('win64');
    expect(cftPlatformFor('freebsd', 'x64')).toBeNull();
    expect(DRIVER_COMPATIBILITY.isSupportedHost('linux', 'x64')).toBe(true);
    expect(DRIVER_COMPATIBILITY.isSupportedHost('linux', 'ppc64')).toBe(false);
  });

  it('produces a stable table hash that changes with the table', () => {
    expect(capabilityTableHash()).toBe(capabilityTableHash());
    expect(
      capabilityTableHash({
        ...DRIVER_COMPATIBILITY,
        capabilities: DRIVER_COMPATIBILITY.capabilities.slice(1),
      }),
    ).not.toBe(capabilityTableHash());
  });
});

describe('@no-llm compatibility probe verdicts', () => {
  it('passes a build newer than the tested pairing as capability-checked', async () => {
    const { service } = makeHarness();

    const result = await service.check(installation(NEWER_THAN_TESTED), {
      profile: 'automation',
      fresh: true,
    });

    expect(result.verdict).toEqual({ status: 'passed', pairing: 'capability-checked' });
    expect(result.capabilities.every((entry) => entry.status === 'passed')).toBe(true);
  });

  it('passes the exact tested pairing as tested', async () => {
    const { service } = makeHarness();

    const result = await service.check(installation(TESTED_BUILD), {
      profile: 'automation',
      fresh: true,
    });

    expect(result.verdict).toEqual({ status: 'passed', pairing: 'tested' });
  });

  it.each(requiredCapabilities('recorder').map((row) => row.id))(
    'fails when the required capability %s fails',
    async (failing) => {
      const { service } = makeHarness({
        runners: { [failing]: () => Promise.reject(new Error(`${failing} is unavailable`)) },
      });

      const result = await service.check(installation(), { profile: 'recorder', fresh: true });

      expect(result.verdict.status).toBe('failed');
      expect(result.verdict.status === 'failed' && result.verdict.failureClass).toBe(
        'capability-failure',
      );
      const entry = result.capabilities.find((row) => row.capability === failing);
      expect(entry?.status).toBe('failed');
      expect(entry?.reason).toContain('is unavailable');
    },
  );

  it('reports dependents of a failed row as not-run, naming the prerequisite', async () => {
    const { service } = makeHarness({
      runners: { 'runtime-evaluate': () => Promise.reject(new Error('no Runtime domain')) },
    });

    const result = await service.check(installation(), { profile: 'recorder', fresh: true });

    const domHandles = result.capabilities.find((row) => row.capability === 'dom-handles');
    expect(domHandles).toEqual({
      capability: 'dom-handles',
      status: 'not-run',
      reason: 'prerequisite "runtime-evaluate" did not pass',
    });
    // A transitive dependent names its own direct prerequisite, not the root.
    const clickReplace = result.capabilities.find((row) => row.capability === 'click-replace');
    expect(clickReplace?.reason).toBe('prerequisite "dom-handles" did not pass');
    // And the remediation names the primitive that actually failed.
    expect(result.verdict.status === 'failed' && result.verdict.remediation).toContain(
      'runtime-evaluate',
    );
  });

  it('rejects recording on a recorder-only failure even when automation would pass', async () => {
    const { service } = makeHarness({
      runners: { 'recorder-binding': () => Promise.reject(new Error('addBinding unsupported')) },
    });

    const automation = await service.check(installation(), { profile: 'automation', fresh: true });
    const recorder = await service.check(installation(), { profile: 'recorder', fresh: true });

    expect(automation.verdict.status).toBe('passed');
    expect(recorder.verdict.status).toBe('failed');
    expect(recorder.capabilities.find((row) => row.capability === 'recorder-binding')?.status).toBe(
      'failed',
    );
  });

  it('stamps every result with the driver, probe revision, and table hash', async () => {
    const { service } = makeHarness();

    const result = await service.check(installation(), { profile: 'automation', fresh: true });

    expect(result).toMatchObject({
      schemaVersion: 1,
      driverVersion: DRIVER_COMPATIBILITY.driverVersion,
      testedBuild: DRIVER_COMPATIBILITY.testedBuild,
      probeRevision: DRIVER_COMPATIBILITY.probeRevision,
      capabilityTableHash: capabilityTableHash(),
      profile: 'automation',
    });
  });
});

describe('@no-llm compatibility probe launch failures', () => {
  it('classifies an ordinary startup failure as a launch-environment problem', async () => {
    const { service } = makeHarness({ launchError: new Error('Failed to connect to the browser') });

    const result = await service.check(installation(), { profile: 'automation', fresh: true });

    expect(result.verdict).toMatchObject({ status: 'failed', failureClass: 'launch-environment' });
    expect(result.capabilities.every((row) => row.status === 'not-run')).toBe(true);
  });

  it('renders package-level remediation from the installation’s own deb.deps', async () => {
    const { service } = makeHarness({
      launchError: new Error(
        '/opt/chrome/chrome: error while loading shared libraries: libnss3.so: cannot open shared object file',
      ),
      debDeps: 'libnss3 (>= 2:3.31), libgbm1 (>= 17.1.0), libasound2 (>= 1.0.16)',
    });

    const result = await service.check(installation(), { profile: 'automation', fresh: true });

    expect(result.verdict.status).toBe('failed');
    const verdict = result.verdict as { failureClass: string; remediation: string };
    expect(verdict.failureClass).toBe('missing-runtime-libraries');
    expect(verdict.remediation).toContain('libnss3');
    expect(verdict.remediation).toContain('libgbm1');
    expect(verdict.remediation).toContain('libasound2');
    // Never "use a different Chrome": the user this exists for has no other one.
    expect(verdict.remediation).not.toMatch(/different (Chrome|browser)/i);
  });

  it('still classifies missing libraries when deb.deps is absent, without inventing packages', async () => {
    const { service } = makeHarness({
      launchError: new Error('error while loading shared libraries: libgbm.so.1'),
      debDeps: null,
    });

    const result = await service.check(installation(), { profile: 'automation', fresh: true });

    const verdict = result.verdict as { failureClass: string; remediation: string };
    expect(verdict.failureClass).toBe('missing-runtime-libraries');
    expect(verdict.remediation).toContain('runtime library packages');
  });

  it('keeps a missing-library failure distinct from a capability failure', async () => {
    const missing = await makeHarness({
      launchError: new Error('error while loading shared libraries: libnss3.so'),
      debDeps: 'libnss3',
    }).service.check(installation(), { profile: 'automation', fresh: true });
    const capability = await makeHarness({
      runners: { 'click-replace': () => Promise.reject(new Error('append instead of replace')) },
    }).service.check(installation(), { profile: 'automation', fresh: true });

    expect((missing.verdict as { failureClass: string }).failureClass).toBe(
      'missing-runtime-libraries',
    );
    expect((capability.verdict as { failureClass: string }).failureClass).toBe(
      'capability-failure',
    );
  });

  it('parses deb.deps into bare package names', () => {
    expect(parseDebDeps('libnss3 (>= 2:3.31), libgbm1 (>= 17.1.0)\nlibxkbcommon0')).toEqual([
      'libnss3',
      'libgbm1',
      'libxkbcommon0',
    ]);
    expect(parseDebDeps(null)).toEqual([]);
    expect(parseDebDeps('   ')).toEqual([]);
  });
});

describe('@no-llm compatibility probe session contract', () => {
  it('always launches its own isolated headless ephemeral session', async () => {
    const harness = makeHarness();

    await harness.service.check(installation(), { profile: 'automation', fresh: true });

    expect(harness.launchConfigs).toHaveLength(1);
    const { options, profile, ownership } = harness.launchConfigs[0] as {
      options: { headless: boolean; profile: { kind: string }; browserSelection: unknown };
      profile: ResolvedProfile;
      ownership: { kind: string };
    };
    expect(options.headless).toBe(true);
    expect(options.profile).toEqual({ kind: 'ephemeral' });
    expect(profile.kind).toBe('ephemeral');
    // The probe takes no ordinary managed reservation of its own.
    expect(ownership.kind).toBe('external');
  });

  it('closes the synthetic session and removes its profile on success', async () => {
    const harness = makeHarness();

    await harness.service.check(installation(), { profile: 'automation', fresh: true });

    expect(harness.shutdowns()).toBe(1);
    expect(harness.profileStore.cleaned).toEqual([harness.profileStore.resolved[0]!.absolutePath]);
  });

  it('closes the synthetic session and removes its profile on capability failure', async () => {
    const harness = makeHarness({
      runners: { 'dom-handles': () => Promise.reject(new Error('handles unavailable')) },
    });

    await harness.service.check(installation(), { profile: 'automation', fresh: true });

    expect(harness.shutdowns()).toBe(1);
    expect(harness.profileStore.cleaned).toHaveLength(1);
  });

  it('removes the synthetic profile even when the session shutdown fails', async () => {
    const harness = makeHarness({ shutdownError: new Error('process would not exit') });

    await harness.service.check(installation(), { profile: 'automation', fresh: true });

    expect(harness.profileStore.cleaned).toHaveLength(1);
  });

  it('does not fail the probe when profile cleanup fails', async () => {
    const harness = makeHarness({ cleanupError: new Error('EBUSY') });

    const result = await harness.service.check(installation(), {
      profile: 'automation',
      fresh: true,
    });

    expect(result.verdict.status).toBe('passed');
    expect(harness.shutdowns()).toBe(1);
  });

  it('closes the synthetic session when a capability run is aborted', async () => {
    const controller = new AbortController();
    const harness = makeHarness({
      runners: {
        'pipe-version': () => {
          controller.abort();
          return Promise.resolve();
        },
      },
    });

    await expect(
      harness.service.check(installation(), {
        profile: 'automation',
        fresh: true,
        signal: controller.signal,
      }),
    ).rejects.toThrow();

    expect(harness.shutdowns()).toBe(1);
    expect(harness.profileStore.cleaned).toHaveLength(1);
  });

  it('never receives a user URL, user profile, task input, or screenshot request', async () => {
    const seen: ProbeContext[] = [];
    const harness = makeHarness({
      runners: {
        'pipe-version': (ctx) => {
          seen.push(ctx);
          return Promise.resolve();
        },
      },
    });

    await harness.service.check(installation(), { profile: 'automation', fresh: true });

    const context = seen[0]!;
    expect(Object.keys(context).sort()).toEqual(['browser', 'cdp', 'page', 'signal']);
    // No screenshot surface is reachable from the probe context.
    expect((context as unknown as Record<string, unknown>).screenshot).toBeUndefined();
    const { options } = harness.launchConfigs[0] as {
      options: { extraArgs: readonly string[]; profile: { kind: string } };
    };
    expect(options.extraArgs).toEqual([]);
    expect(options.profile.kind).toBe('ephemeral');
  });

  it('makes no network call from a probe', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const harness = makeHarness();

    try {
      await harness.service.check(installation(), { profile: 'automation', fresh: true });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('@no-llm compatibility evidence reuse', () => {
  let cacheRoot: string;

  beforeEach(async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), 'yantra-compat-svc-'));
  });

  afterEach(async () => {
    await rm(cacheRoot, { recursive: true, force: true });
  });

  it('is one probe implementation shared by the launch path and by check()', async () => {
    const harness = makeHarness({ cacheRoot });
    // Spy on the instance, not on an outer wrapper: a decorator around the
    // service cannot observe its internal `this.runProbe()` calls at all.
    const runProbe = vi.spyOn(harness.service, 'runProbe');

    await harness.service.ensureCompatible(installation(), 'automation');
    await harness.service.check(installation(), { profile: 'automation', fresh: true });

    expect(runProbe).toHaveBeenCalledTimes(2);
    expect(runProbe.mock.instances.every((instance) => instance === harness.service)).toBe(true);
  });

  it('reuses cached evidence on the launch path instead of probing again', async () => {
    const harness = makeHarness({ cacheRoot });
    const runProbe = vi.spyOn(harness.service, 'runProbe');

    await harness.service.ensureCompatible(installation(), 'automation');
    await harness.service.ensureCompatible(installation(), 'automation');

    expect(runProbe).toHaveBeenCalledTimes(1);
    expect(harness.launchConfigs).toHaveLength(1);
  });

  it('always bypasses a cached success when fresh is requested', async () => {
    const harness = makeHarness({ cacheRoot });
    await harness.service.ensureCompatible(installation(), 'automation');

    await harness.service.check(installation(), { profile: 'automation', fresh: true });

    expect(harness.launchConfigs).toHaveLength(2);
  });

  it('reads cached evidence without launching, and reports unverified when there is none', async () => {
    const harness = makeHarness({ cacheRoot });

    await expect(harness.service.readCached(installation(), 'automation')).resolves.toEqual({
      state: 'unverified',
    });
    expect(harness.launchConfigs).toHaveLength(0);

    await harness.service.ensureCompatible(installation(), 'automation');
    const state = await harness.service.readCached(installation(), 'automation');

    expect(state.state).toBe('evidence');
    expect(harness.launchConfigs).toHaveLength(1);
  });

  it('does not let automation evidence satisfy the recorder profile', async () => {
    const harness = makeHarness({ cacheRoot });
    await harness.service.ensureCompatible(installation(), 'automation');

    await expect(harness.service.readCached(installation(), 'recorder')).resolves.toEqual({
      state: 'unverified',
    });
  });

  it('re-probes when the executable changed underneath the evidence', async () => {
    const harness = makeHarness({ cacheRoot });
    await harness.service.ensureCompatible(installation(NEWER_THAN_TESTED), 'automation');

    await harness.service.ensureCompatible(installation('154.0.1.0'), 'automation');

    expect(harness.launchConfigs).toHaveLength(2);
  });

  it('reports cache provenance without probing, and probe provenance when it probes', async () => {
    const harness = makeHarness({ cacheRoot });

    const first = await harness.service.decide(installation(), {
      profile: 'automation',
      fresh: false,
    });
    const second = await harness.service.decide(installation(), {
      profile: 'automation',
      fresh: false,
    });

    expect(first.evidenceSource).toBe('probe');
    expect(second.evidenceSource).toBe('cache');
    // The second answer is the first answer — provenance is the only difference.
    expect(second.result).toEqual(first.result);
    expect(harness.launchConfigs).toHaveLength(1);
  });

  it('reports probe provenance for a fresh decision even with valid evidence cached', async () => {
    const harness = makeHarness({ cacheRoot });
    await harness.service.decide(installation(), { profile: 'automation', fresh: false });

    const fresh = await harness.service.decide(installation(), {
      profile: 'automation',
      fresh: true,
    });

    expect(fresh.evidenceSource).toBe('probe');
    expect(harness.launchConfigs).toHaveLength(2);
  });

  it('routes check() and decide() through the same single probe implementation', async () => {
    const harness = makeHarness({ cacheRoot });
    const runProbe = vi.spyOn(harness.service, 'runProbe');

    await harness.service.check(installation(), { profile: 'automation', fresh: true });
    await harness.service.decide(installation(), { profile: 'automation', fresh: true });

    expect(runProbe).toHaveBeenCalledTimes(2);
    expect(runProbe.mock.instances.every((instance) => instance === harness.service)).toBe(true);
  });

  it('never writes invocation-only provenance into the persisted cache record', async () => {
    const harness = makeHarness({ cacheRoot });
    await harness.service.decide(installation(), { profile: 'automation', fresh: false });

    const state = await harness.service.readCached(installation(), 'automation');

    expect(state.state).toBe('evidence');
    if (state.state !== 'evidence') throw new Error('unreachable');
    expect(state.result).not.toHaveProperty('evidenceSource');
    expect(state.result.schemaVersion).toBe(1);
    // And the bytes on disk agree: a cache hit must not have rewritten the file
    // with a provenance that is already wrong for the next reader.
    const files = await readdir(cacheRoot, { recursive: true, withFileTypes: true });
    const records = files.filter((entry) => entry.isFile() && entry.name.endsWith('.json'));
    expect(records.length).toBeGreaterThan(0);
    for (const entry of records) {
      const raw = await readFile(join(entry.parentPath, entry.name), 'utf8');
      expect(raw).not.toContain('evidenceSource');
    }
  });

  it('never records a failure as reusable evidence', async () => {
    const harness = makeHarness({
      cacheRoot,
      runners: { 'pipe-version': () => Promise.reject(new Error('no pipe')) },
    });

    await harness.service.ensureCompatible(installation(), 'automation');
    await harness.service.ensureCompatible(installation(), 'automation');

    expect(harness.launchConfigs).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Real synthetic checks against the provisioned browser
// ---------------------------------------------------------------------------

describe.runIf(process.env['YANTRA_E2E_BROWSER'] === '1')(
  '@no-llm compatibility probe against a real browser',
  () => {
    let fixture: Awaited<ReturnType<typeof beginMigrationBrowserFixture>>;

    beforeAll(async () => {
      fixture = await beginMigrationBrowserFixture({ requireProvisioned: true });
    });

    afterAll(async () => {
      await fixture?.cleanup();
    });

    async function realInstallation(): Promise<ResolvedBrowserInstallation> {
      const { identifyExecutable } = await import('../../src/browser/browser-resolver.js');
      const identity = await identifyExecutable(fixture.executablePath!);
      if (identity === null) throw new Error('the provisioned browser could not be identified');
      return {
        ...identity,
        ownership: 'external',
        requestedSelection: { source: 'system', executablePath: fixture.executablePath! },
        selectionOrigin: 'invocation',
        selectionReason: 'custom-path',
        channel: 'stable',
        managedIdentity: null,
      };
    }

    it.each(['automation', 'recorder'] as const)(
      'passes every required %s primitive on synthetic pages only',
      async (profile: ProbeProfile) => {
        const service = new LocalBrowserCompatibilityService();

        const result = await service.check(await realInstallation(), { profile, fresh: true });

        expect(result.verdict.status).toBe('passed');
        expect(result.capabilities.map((row) => row.capability).sort()).toEqual(
          requiredCapabilities(profile)
            .map((row) => row.id)
            .sort(),
        );
      },
      120_000,
    );

    it('prevents the attempted user URL from opening when a required primitive fails', async () => {
      const attemptedUserUrl = 'https://example.invalid/checkout';
      const navigated: string[] = [];
      const service = new LocalBrowserCompatibilityService({
        capabilityRunners: {
          'pipe-version': (ctx) => {
            // Record every target this synthetic browser ever opens.
            ctx.browser.on('targetcreated', (target) => navigated.push(target.url()));
            ctx.browser.on('targetchanged', (target) => navigated.push(target.url()));
            return Promise.resolve();
          },
          'runtime-evaluate': () => Promise.reject(new Error('simulated primitive failure')),
        },
      });

      const result = await service.check(await realInstallation(), {
        profile: 'automation',
        fresh: true,
      });

      // A failed verdict is the gate a caller consults before navigating, and
      // the probe itself never had a way to reach the user's URL at all.
      expect(result.verdict.status).toBe('failed');
      expect(navigated.some((url) => url.includes('example.invalid'))).toBe(false);
      expect(
        navigated.every((url) => url === '' || url === 'about:blank' || url.startsWith('chrome')),
      ).toBe(true);
      expect(JSON.stringify(result)).not.toContain(attemptedUserUrl);
    }, 120_000);
  },
);
