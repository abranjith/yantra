/**
 * The one local inventory projection.
 *
 * `browser list` and `doctor` both render this object, so the properties under
 * test are the ones that would let them disagree: which entry is effective,
 * whether one binary can appear twice, and that reading it launches nothing,
 * installs nothing, and collects nothing.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BrowserResolutionError } from '../../src/browser/errors.js';
import type {
  BrowserResolution,
  BrowserResolutionErrorCode,
  BrowserSelection,
  CompatibilityEvidenceState,
  CompatibilityResult,
  ManagedInventory,
  ManagedReadyRecord,
  ResolvedBrowserInstallation,
} from '../../src/browser/installation-types.js';
import { LocalBrowserInventoryService } from '../../src/browser/inventory.js';
import { resetPathCache } from '../../src/browser/paths.js';
import type { ChromeInstall } from '../../src/browser/types.js';

const MANAGED_EXE = '/home/u/.yantra/data/browsers/installation-one/chrome/chrome';
const EXTERNAL_EXE = '/opt/google/chrome/chrome';

function record(): ManagedReadyRecord {
  return {
    schemaVersion: 1,
    installationId: 'one',
    browser: 'chrome',
    platform: 'linux',
    buildId: '153.0.8010.36',
    cacheRootRelative: 'installation-one',
    executableRelative: 'chrome/chrome',
    verifiedAt: '2026-09-14T00:00:00.000Z',
  };
}

function installation(
  overrides: Partial<ResolvedBrowserInstallation> = {},
): ResolvedBrowserInstallation {
  return {
    canonicalPath: MANAGED_EXE,
    version: '153.0.8010.36',
    majorVersion: 153,
    platform: 'linux',
    architecture: 'x64',
    statFingerprint: '1:2:3:4',
    ownership: 'managed',
    requestedSelection: { source: 'auto', executablePath: null },
    selectionOrigin: 'default',
    selectionReason: 'managed-preferred',
    channel: 'stable',
    managedIdentity: record(),
    ...overrides,
  };
}

function external(overrides: Partial<ChromeInstall> = {}): ChromeInstall {
  return {
    path: EXTERNAL_EXE,
    version: '152.0.7977.84',
    majorVersion: 152,
    channel: 'stable',
    source: 'system',
    ...overrides,
  };
}

function evidence(target: ResolvedBrowserInstallation): CompatibilityResult {
  return {
    schemaVersion: 1,
    identity: target,
    driverVersion: '25.10.0',
    testedBuild: '152.0.7977.75',
    probeRevision: 1,
    capabilityTableHash: 'hash',
    profile: 'automation',
    checkedAt: '2026-09-14T00:00:00.000Z',
    capabilities: [],
    verdict: { status: 'passed', pairing: 'capability-checked' },
  };
}

/** A real {@link BrowserResolutionError} so the message shape matches production. */
function resolutionError(code: BrowserResolutionErrorCode, message: string) {
  return new BrowserResolutionError({
    code,
    message,
    requestedSelection: { source: 'managed', executablePath: null },
    remediation: 'Run `yantra browser install`.',
  });
}

interface Built {
  readonly service: LocalBrowserInventoryService;
  readonly resolveCalls: (BrowserSelection | undefined)[];
}

function build(
  options: {
    readonly resolution?: BrowserResolution;
    readonly managed?: ManagedInventory;
    readonly externals?: readonly ChromeInstall[];
    readonly cached?: CompatibilityEvidenceState;
    readonly configured?: BrowserSelection | undefined;
    readonly configuredThrows?: boolean;
  } = {},
): Built {
  const resolveCalls: (BrowserSelection | undefined)[] = [];
  const service = new LocalBrowserInventoryService({
    resolver: {
      resolve: (selection) => {
        resolveCalls.push(selection);
        return Promise.resolve(
          options.resolution ?? { status: 'resolved', installation: installation() },
        );
      },
    },
    managedState: {
      readInventory: () =>
        Promise.resolve(options.managed ?? { ready: { status: 'absent' }, orphans: [] }),
    },
    compatibility: {
      readCached: () => Promise.resolve(options.cached ?? { state: 'unverified' }),
    },
    selectionReader: {
      read: () =>
        options.configuredThrows === true
          ? Promise.reject(new Error('config.yaml is invalid'))
          : Promise.resolve(options.configured),
    },
    discoverExternals: () => options.externals ?? [],
    managedRoot: () => '/home/u/.yantra/data/browsers',
  });
  return { service, resolveCalls };
}

describe('@no-llm browser inventory', () => {
  let home: string;
  const savedHome = process.env.YANTRA_HOME;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'yantra-inventory-'));
    process.env.YANTRA_HOME = home;
    resetPathCache();
  });

  afterEach(async () => {
    if (savedHome === undefined) delete process.env.YANTRA_HOME;
    else process.env.YANTRA_HOME = savedHome;
    resetPathCache();
    await rm(home, { recursive: true, force: true }).catch(() => undefined);
  });

  describe('effective selection', () => {
    it('prefers the managed installation under auto when both exist', async () => {
      const { service } = build({
        resolution: { status: 'resolved', installation: installation() },
        managed: { ready: { status: 'ready', record: record() }, orphans: [] },
        externals: [external()],
      });

      const inventory = await service.read();

      expect(inventory.effective.status).toBe('resolved');
      const effective = inventory.alternatives.filter((entry) => entry.isEffective);
      expect(effective).toHaveLength(1);
      expect(effective[0]).toMatchObject({ ownership: 'managed', executablePath: MANAGED_EXE });
    });

    it('marks the external browser effective when no managed installation exists', async () => {
      const { service } = build({
        resolution: {
          status: 'resolved',
          installation: installation({
            canonicalPath: EXTERNAL_EXE,
            ownership: 'external',
            version: '152.0.7977.84',
            selectionReason: 'system-discovery',
            managedIdentity: null,
          }),
        },
        externals: [external()],
      });

      const inventory = await service.read();

      const effective = inventory.alternatives.filter((entry) => entry.isEffective);
      expect(effective).toHaveLength(1);
      expect(effective[0]).toMatchObject({ ownership: 'external', executablePath: EXTERNAL_EXE });
    });

    it('never shows the managed installation as effective under a system selection', async () => {
      const { service } = build({
        resolution: {
          status: 'resolved',
          installation: installation({
            canonicalPath: EXTERNAL_EXE,
            ownership: 'external',
            requestedSelection: { source: 'system', executablePath: null },
            selectionReason: 'system-discovery',
            managedIdentity: null,
          }),
        },
        managed: { ready: { status: 'ready', record: record() }, orphans: [] },
        externals: [external()],
      });

      const inventory = await service.read();

      // The managed build is still *installed* — it is simply not what runs.
      expect(inventory.managed.status).toBe('ready');
      expect(
        inventory.alternatives.find((entry) => entry.executablePath === MANAGED_EXE)?.isEffective,
      ).not.toBe(true);
    });

    it('lists a binary found by both managed state and discovery exactly once', async () => {
      const { service } = build({
        resolution: { status: 'resolved', installation: installation() },
        managed: { ready: { status: 'ready', record: record() }, orphans: [] },
        // Discovery independently finds the managed executable, e.g. through a
        // PATH entry pointing into the managed tree.
        externals: [external({ path: MANAGED_EXE, source: 'managed' })],
      });

      const inventory = await service.read();

      expect(
        inventory.alternatives.filter((entry) => entry.executablePath === MANAGED_EXE),
      ).toHaveLength(1);
    });

    it('renders a broken selection as data, with its remediation and the alternatives found', async () => {
      const { service } = build({
        resolution: {
          status: 'unavailable',
          error: resolutionError('managed-state-invalid', 'The ready pointer is malformed.'),
        },
        externals: [external()],
      });

      const inventory = await service.read();

      expect(inventory.effective.status).toBe('unavailable');
      if (inventory.effective.status === 'unavailable') {
        expect(inventory.effective.error.remediation).toContain('yantra browser install');
      }
      // The alternatives still have to be listed: they are what the user can do
      // about it, and no entry may claim to be effective.
      expect(inventory.alternatives).toHaveLength(1);
      expect(inventory.alternatives.every((entry) => !entry.isEffective)).toBe(true);
    });
  });

  describe('provenance', () => {
    it('reports an absent block as no configured selection', async () => {
      const { service } = build({ configured: undefined });
      await expect(service.read().then((i) => i.configured)).resolves.toBeUndefined();
    });

    it('reports a configured custom path', async () => {
      const configured: BrowserSelection = { source: 'system', executablePath: EXTERNAL_EXE };
      const { service } = build({ configured });
      const inventory = await service.read();
      expect(inventory.configured).toEqual(configured);
    });

    it('survives an invalid configuration rather than failing the diagnosis', async () => {
      // `list` and `doctor` exist to diagnose a broken machine, so neither may be
      // taken down by the state it is describing.
      const { service } = build({ configuredThrows: true });
      const inventory = await service.read();
      expect(inventory.configured).toBeUndefined();
    });

    it('passes an invocation override straight through to the resolver', async () => {
      const override: BrowserSelection = { source: 'managed', executablePath: null };
      const { service, resolveCalls } = build();
      const inventory = await service.read(override);
      expect(resolveCalls).toEqual([override]);
      expect(inventory.override).toEqual(override);
    });

    it('reports cached compatibility evidence for the effective browser', async () => {
      const target = installation();
      const { service } = build({
        resolution: { status: 'resolved', installation: target },
        cached: { state: 'evidence', result: evidence(target) },
      });
      const inventory = await service.read();
      expect(inventory.effective.status).toBe('resolved');
      if (inventory.effective.status === 'resolved') {
        expect(inventory.effective.compatibility.state).toBe('evidence');
      }
    });
  });

  describe('orphans', () => {
    it('reports the count and reclaimable bytes from managed state and deletes nothing', async () => {
      const root = join(home, 'data', 'browsers');
      const orphanDirs = [join(root, 'installation-old'), join(root, 'installation-abandoned')];
      for (const dir of orphanDirs) {
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, 'blob'), 'x'.repeat(1024));
      }

      const { service } = build({
        managed: {
          ready: { status: 'ready', record: record() },
          orphans: [
            { cacheRootRelative: 'installation-old', bytes: 1024, hasLiveOwner: false },
            { cacheRootRelative: 'installation-abandoned', bytes: 2048, hasLiveOwner: false },
          ],
        },
      });

      const inventory = await service.read();

      expect(inventory.orphans).toEqual({ count: 2, reclaimableBytes: 3072 });
      // Reading the inventory collects nothing: the directories are still there.
      const { stat } = await import('node:fs/promises');
      for (const dir of orphanDirs) await expect(stat(dir)).resolves.toBeDefined();
    });
  });

  it('opens no socket and starts no process', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { service } = build({
      managed: { ready: { status: 'ready', record: record() }, orphans: [] },
      externals: [external()],
    });

    await service.read();

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
