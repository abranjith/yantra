import * as fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { doctor } from '../../src/browser/doctor.js';
import type {
  BrowserResolution,
  BrowserRuntimeServices,
  CompatibilityEvidenceState,
  CompatibilityResult,
  ManagedInventory,
  ManagedReadyRecord,
  ResolvedBrowserInstallation,
} from '../../src/browser/installation-types.js';
import type * as Paths from '../../src/browser/paths.js';

vi.mock('../../src/browser/chrome-discovery.js', () => ({
  detectChrome: vi.fn(),
}));
vi.mock('node:fs/promises', () => ({
  access: vi.fn(),
  constants: { W_OK: 2 },
  mkdir: vi.fn(),
  readFile: vi.fn(),
  readdir: vi.fn().mockResolvedValue([]),
  stat: vi.fn(),
  writeFile: vi.fn(),
}));
// Partial: a wholesale replacement silently drops every export not listed.
vi.mock('../../src/browser/paths.js', async (importOriginal) => ({
  ...(await importOriginal<typeof Paths>()),
  dataDir: vi.fn(() => '/home/testuser/.local/share/yantra'),
  cacheDir: vi.fn(() => '/home/testuser/.cache/yantra'),
  profilesRoot: vi.fn(() => '/home/testuser/.local/share/yantra/profiles'),
  doctorCachePath: vi.fn(() => '/home/testuser/.cache/yantra/doctor.json'),
}));
vi.mock('keytar', () => ({
  default: {
    setPassword: vi.fn().mockResolvedValue(undefined),
    getPassword: vi.fn().mockResolvedValue('ok'),
    deletePassword: vi.fn().mockResolvedValue(true),
  },
}));
vi.mock('../../src/index-db/db.js', () => ({
  openIndexDb: vi.fn(),
  indexDbPath: vi.fn(() => '/home/testuser/.local/share/yantra/index.db'),
  setMeta: vi.fn(),
}));
vi.mock('../../src/index-db/history-store.js', () => ({
  SqliteHistoryStore: class {
    async rebuildFromRuns() {
      return { isOk: true as const, value: { rowCount: 0 } };
    }
  },
}));

const mockDetectChrome = vi.mocked(
  await import('../../src/browser/chrome-discovery.js').then((m) => m.detectChrome),
);
const fsMocks = await import('node:fs/promises');
const mockReadFile = vi.mocked(fsMocks.readFile);
const mockWriteFile = vi.mocked(fsMocks.writeFile);
const mockAccess = vi.mocked(fsMocks.access);
const mockStat = vi.mocked(fsMocks.stat);
const mockMkdir = vi.mocked(fsMocks.mkdir);
const keytarMocks = (await import('keytar')) as {
  default: {
    setPassword: ReturnType<typeof vi.fn>;
    getPassword: ReturnType<typeof vi.fn>;
    deletePassword: ReturnType<typeof vi.fn>;
  };
};
const mockOpenIndexDb = vi.mocked((await import('../../src/index-db/db.js')).openIndexDb);

function makeInstallation(
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

const READY: ManagedReadyRecord = {
  schemaVersion: 1,
  installationId: 'one',
  browser: 'chrome',
  platform: 'linux',
  buildId: '153.0.8010.36',
  cacheRootRelative: 'installation-one',
  executableRelative: 'chrome/chrome',
  verifiedAt: '2026-09-14T00:00:00.000Z',
};

function passingEvidence(installation: ResolvedBrowserInstallation): CompatibilityResult {
  return {
    schemaVersion: 1,
    identity: installation,
    driverVersion: '25.10.0',
    testedBuild: '152.0.7977.75',
    probeRevision: 1,
    capabilityTableHash: 'hash',
    profile: 'automation',
    checkedAt: '2026-09-13T00:00:00.000Z',
    capabilities: [{ capability: 'pipe-version', status: 'passed', reason: null }],
    verdict: { status: 'passed', pairing: 'capability-checked' },
  };
}

/**
 * Doctor's browser view is read-only by construction: these doubles have no
 * launch path at all, so a test cannot accidentally pass by starting a browser.
 */
function makeServices(
  opts: {
    resolution?: BrowserResolution;
    evidence?: CompatibilityEvidenceState;
    resolveError?: Error;
    managed?: ManagedInventory;
  } = {},
): BrowserRuntimeServices & { readonly probes: number } {
  let probes = 0;
  const resolution =
    opts.resolution ?? ({ status: 'resolved', installation: makeInstallation() } as const);
  const managed: ManagedInventory = opts.managed ?? { ready: { status: 'absent' }, orphans: [] };
  const services = {
    resolver: {
      resolve: vi.fn(() =>
        opts.resolveError ? Promise.reject(opts.resolveError) : Promise.resolve(resolution),
      ),
    },
    compatibility: {
      check: vi.fn(() => {
        probes += 1;
        return Promise.reject(new Error('doctor must never probe'));
      }),
      readCached: vi.fn(() => Promise.resolve(opts.evidence ?? { state: 'unverified' as const })),
    },
    coordinator: {
      reserveUse: vi.fn(),
      claimMutation: vi.fn(),
      hasActiveUse: vi.fn().mockResolvedValue(false),
    },
    managedState: {
      readReady: vi.fn().mockResolvedValue(managed.ready),
      readInventory: vi.fn().mockResolvedValue(managed),
    },
  } as unknown as BrowserRuntimeServices & { probes: number };
  Object.defineProperty(services, 'probes', { get: () => probes });
  return services;
}

let services: BrowserRuntimeServices;

describe('@no-llm doctor', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process, 'platform', { value: 'linux', writable: true });

    // Default: happy path
    services = makeServices({
      evidence: { state: 'evidence', result: passingEvidence(makeInstallation()) },
    });
    mockDetectChrome.mockReturnValue(null);
    mockReadFile.mockRejectedValue(new Error('ENOENT')); // no cache by default
    mockWriteFile.mockResolvedValue(undefined);
    mockAccess.mockResolvedValue(undefined);
    mockMkdir.mockResolvedValue(undefined as unknown as string);
    mockStat.mockResolvedValue({ isDirectory: () => true, mode: 0o700 } as Awaited<
      ReturnType<typeof mockStat>
    >);
    keytarMocks.default.setPassword.mockResolvedValue(undefined);
    keytarMocks.default.getPassword.mockResolvedValue('ok');
    keytarMocks.default.deletePassword.mockResolvedValue(true);
    mockOpenIndexDb.mockResolvedValue({
      db: { close: vi.fn() } as never,
      path: '/home/testuser/.local/share/yantra/index.db',
      wasCorrupt: false,
    });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true });
  });

  describe('overall: all checks pass', () => {
    it('returns overall=ok when everything passes', async () => {
      const report = await doctor({ refresh: true, services });
      expect(report.overall).toBe('ok');
      expect(report.checks).toHaveLength(8);
    });

    it('has a valid ISO-8601 generatedAt', async () => {
      const report = await doctor({ refresh: true, services });
      expect(new Date(report.generatedAt).toISOString()).toBe(report.generatedAt);
    });

    it('sets cachedFrom=null on fresh run', async () => {
      const report = await doctor({ refresh: true, services });
      expect(report.cachedFrom).toBeNull();
    });
  });

  describe('browser.selection check', () => {
    it('reports the browser the resolver selected, with its provenance', async () => {
      const report = await doctor({ refresh: true, services });
      const check = report.checks.find((c) => c.id === 'browser.selection');

      expect(check?.status).toBe('ok');
      expect(check?.details).toMatchObject({
        path: '/usr/bin/google-chrome',
        ownership: 'external',
        source: 'auto',
        selectionReason: 'system-discovery',
      });
    });

    it('reports managed ownership when the resolver selected a managed build', async () => {
      services = makeServices({
        resolution: {
          status: 'resolved',
          installation: makeInstallation({
            ownership: 'managed',
            selectionReason: 'managed-preferred',
          }),
        },
      });

      const report = await doctor({ refresh: true, services });
      const check = report.checks.find((c) => c.id === 'browser.selection');

      expect(check?.details).toMatchObject({ ownership: 'managed' });
    });

    it('reports the resolver’s own remediation when no browser is available', async () => {
      services = makeServices({
        resolution: {
          status: 'unavailable',
          error: Object.assign(new Error('No Chrome or Chromium installation was found.'), {
            code: 'missing' as const,
            requestedSelection: { source: 'auto' as const, executablePath: null },
            evidence: {},
            remediation: 'Install Chrome or Chromium, or run `yantra browser install`.',
          }),
        },
      });

      const report = await doctor({ refresh: true, services });
      const check = report.checks.find((c) => c.id === 'browser.selection');

      expect(check?.status).toBe('error');
      expect(check?.fixHint).toContain('yantra browser install');
      expect(report.overall).toBe('error');
    });

    it('degrades to a failed browser check rather than losing the whole report', async () => {
      services = makeServices({ resolveError: new Error('the managed root is unreadable') });

      const report = await doctor({ refresh: true, services });

      expect(report.checks).toHaveLength(8);
      expect(report.checks.find((c) => c.id === 'browser.selection')?.status).toBe('error');
    });
  });

  describe('browser.managed check', () => {
    it('reports the managed root and an absent installation without installing', async () => {
      const report = await doctor({ refresh: true, services });
      const check = report.checks.find((c) => c.id === 'browser.managed');

      expect(check?.status).toBe('ok');
      expect(check?.details).toMatchObject({ status: 'absent', orphanCount: 0 });
      expect(check?.details.managedRoot).toBeTruthy();
    });

    it('reports a ready build with its id', async () => {
      services = makeServices({
        managed: { ready: { status: 'ready', record: READY }, orphans: [] },
      });

      const report = await doctor({ refresh: true, services });
      const check = report.checks.find((c) => c.id === 'browser.managed');

      expect(check?.details).toMatchObject({ status: 'ready', buildId: '153.0.8010.36' });
    });

    it('reports orphan count and reclaimable bytes and collects nothing', async () => {
      services = makeServices({
        managed: {
          ready: { status: 'ready', record: READY },
          orphans: [
            { cacheRootRelative: 'installation-old', bytes: 1024, hasLiveOwner: false },
            { cacheRootRelative: 'installation-gone', bytes: 2048, hasLiveOwner: false },
          ],
        },
      });

      const report = await doctor({ refresh: true, services });
      const check = report.checks.find((c) => c.id === 'browser.managed');

      expect(check?.details).toMatchObject({ orphanCount: 2, reclaimableBytes: 3072 });
      expect(check?.message).toContain('2 superseded installation(s)');
      // Doctor has no collection path at all: there is nothing to have called.
      expect(services.managedState.readInventory).toHaveBeenCalled();
    });

    it('reports an unusable ready pointer as an error naming install', async () => {
      services = makeServices({
        managed: {
          ready: { status: 'invalid', reason: 'ready pointer is not valid JSON' },
          orphans: [],
        },
      });

      const report = await doctor({ refresh: true, services });
      const check = report.checks.find((c) => c.id === 'browser.managed');

      expect(check?.status).toBe('error');
      expect(check?.fixHint).toContain('yantra browser install');
    });
  });

  describe('browser.compatibility check', () => {
    it('reports passing local evidence with the pairing and tested build', async () => {
      const report = await doctor({ refresh: true, services });
      const check = report.checks.find((c) => c.id === 'browser.compatibility');

      expect(check?.status).toBe('ok');
      expect(check?.details).toMatchObject({
        compatibility: 'passed',
        pairing: 'capability-checked',
        testedBuild: '152.0.7977.75',
      });
    });

    it('reports unverified honestly instead of launching a browser', async () => {
      services = makeServices({ evidence: { state: 'unverified' } });

      const report = await doctor({ refresh: true, services });
      const check = report.checks.find((c) => c.id === 'browser.compatibility');

      expect(check?.status).toBe('warn');
      expect(check?.details).toMatchObject({ compatibility: 'unverified' });
      expect(check?.fixHint).toContain('yantra browser check');
      expect(services.compatibility.check).not.toHaveBeenCalled();
    });

    it('names the failing primitives when evidence records a failure', async () => {
      const installation = makeInstallation();
      services = makeServices({
        evidence: {
          state: 'evidence',
          result: {
            ...passingEvidence(installation),
            capabilities: [
              { capability: 'pipe-version', status: 'passed', reason: null },
              { capability: 'popup-session', status: 'failed', reason: 'no popup event' },
            ],
            verdict: {
              status: 'failed',
              failureClass: 'capability-failure',
              remediation: 'Install a current Chrome or Chromium.',
            },
          },
        },
      });

      const report = await doctor({ refresh: true, services });
      const check = report.checks.find((c) => c.id === 'browser.compatibility');

      expect(check?.status).toBe('error');
      expect(check?.message).toContain('popup-session');
      expect(check?.details).toMatchObject({ failing: ['popup-session'] });
    });

    it('never states a fixed minimum Chrome major', async () => {
      const report = await doctor({ refresh: true, services });
      const rendered = JSON.stringify(report);

      // The old check asserted "Chrome major version >= 120"; a build outside
      // the tested pairing is now the normal case, not a fault.
      expect(rendered).not.toContain('120');
      expect(rendered).not.toMatch(/minimum (required )?version/i);
      // The whole `chrome.` id namespace is retired: the replacement checks
      // report selection provenance, not bare detection.
      expect(report.checks.every((c) => !c.id.startsWith('chrome.'))).toBe(true);
    });

    it('never launches a browser to manufacture an ok result', async () => {
      services = makeServices({ evidence: { state: 'unverified' } });

      await doctor({ refresh: true, services });

      expect(services.compatibility.check).not.toHaveBeenCalled();
      expect(services.compatibility.readCached).toHaveBeenCalledWith(
        expect.objectContaining({ canonicalPath: '/usr/bin/google-chrome' }),
        'automation',
      );
    });
  });

  describe('datadir.writable check', () => {
    it('returns ok when dir is writable', async () => {
      const report = await doctor({ refresh: true, services });
      const check = report.checks.find((c) => c.id === 'datadir.writable');
      expect(check?.status).toBe('ok');
    });

    it('returns error when dir is not writable', async () => {
      mockAccess.mockRejectedValue(new Error('EACCES'));
      mockMkdir.mockRejectedValue(new Error('EACCES'));
      const report = await doctor({ refresh: true, services });
      const check = report.checks.find((c) => c.id === 'datadir.writable');
      expect(check?.status).toBe('error');
    });
  });

  describe('datadir.permissions check', () => {
    it('returns ok when mode is 0700', async () => {
      mockStat.mockResolvedValue({
        isDirectory: () => true,
        mode: 0o700,
      } as Awaited<ReturnType<typeof mockStat>>);
      const report = await doctor({ refresh: true, services });
      const check = report.checks.find((c) => c.id === 'datadir.permissions');
      expect(check?.status).toBe('ok');
    });

    it('returns warn when mode is 0755', async () => {
      mockStat.mockResolvedValue({
        isDirectory: () => true,
        mode: 0o755,
      } as Awaited<ReturnType<typeof mockStat>>);
      const report = await doctor({ refresh: true, services });
      const check = report.checks.find((c) => c.id === 'datadir.permissions');
      expect(check?.status).toBe('warn');
    });

    it('returns ok with note on Windows', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32', writable: true });
      const report = await doctor({ refresh: true, services });
      const check = report.checks.find((c) => c.id === 'datadir.permissions');
      expect(check?.status).toBe('ok');
      expect(check?.details['note']).toBeTruthy();
    });
  });

  describe('cachedir.writable check', () => {
    it('returns ok when cache dir is writable', async () => {
      const report = await doctor({ refresh: true, services });
      const check = report.checks.find((c) => c.id === 'cachedir.writable');
      expect(check?.status).toBe('ok');
    });
  });

  describe('keychain.reachable check', () => {
    it('returns ok on successful round-trip', async () => {
      const report = await doctor({ refresh: true, services });
      const check = report.checks.find((c) => c.id === 'keychain.reachable');
      expect(check?.status).toBe('ok');
    });

    it('returns error when keytar throws', async () => {
      keytarMocks.default.setPassword.mockRejectedValue(new Error('keychain locked'));
      const report = await doctor({ refresh: true, services });
      const check = report.checks.find((c) => c.id === 'keychain.reachable');
      expect(check?.status).toBe('error');
    });

    it('returns error when round-trip value does not match', async () => {
      keytarMocks.default.getPassword.mockResolvedValue('wrong-value');
      const report = await doctor({ refresh: true, services });
      const check = report.checks.find((c) => c.id === 'keychain.reachable');
      expect(check?.status).toBe('error');
    });
  });

  describe('indexdb.writable check', () => {
    it('returns ok when the index opens and accepts a write', async () => {
      const report = await doctor({ refresh: true, services });
      const check = report.checks.find((c) => c.id === 'indexdb.writable');
      expect(check?.status).toBe('ok');
    });

    it('returns warn when the index was corrupt and rebuilt', async () => {
      mockOpenIndexDb.mockResolvedValue({
        db: { close: vi.fn() } as never,
        path: '/home/testuser/.local/share/yantra/index.db',
        wasCorrupt: true,
      });
      const report = await doctor({ refresh: true, services });
      const check = report.checks.find((c) => c.id === 'indexdb.writable');
      expect(check?.status).toBe('warn');
    });

    it('returns error when the index cannot be opened', async () => {
      mockOpenIndexDb.mockRejectedValue(new Error('EACCES: permission denied'));
      const report = await doctor({ refresh: true, services });
      const check = report.checks.find((c) => c.id === 'indexdb.writable');
      expect(check?.status).toBe('error');
    });
  });

  describe('cache behavior', () => {
    /** The exact payload a fresh run writes, including its browser fingerprint. */
    async function writtenCache(
      bag: BrowserRuntimeServices,
    ): Promise<Record<string, unknown> & { generatedAt: string }> {
      mockReadFile.mockRejectedValue(new Error('ENOENT'));
      await doctor({ refresh: true, services: bag });
      const written = mockWriteFile.mock.calls.at(-1)?.[1];
      return JSON.parse(String(written)) as Record<string, unknown> & { generatedAt: string };
    }

    it('serves cached report when TTL has not expired', async () => {
      const cached = await writtenCache(services);
      mockReadFile.mockResolvedValue(JSON.stringify(cached));
      const keychain = keytarMocks.default.setPassword;
      keychain.mockClear();

      const report = await doctor({ services });

      expect(report.cachedFrom).toBe(cached.generatedAt);
      // The expensive probes are what the cache saves; the browser fingerprint
      // is read on every invocation, by design, so that a selection change
      // invalidates the report without `--refresh`.
      expect(keychain).not.toHaveBeenCalled();
    });

    it('does not leak the fingerprint field into the returned report', async () => {
      const cached = await writtenCache(services);
      mockReadFile.mockResolvedValue(JSON.stringify(cached));

      const report = await doctor({ services });

      expect(report).not.toHaveProperty('browserFingerprint');
    });

    // The whole point of keying on browser identity: the user changes their
    // selection and the next `doctor` describes the new browser, with no flag.
    it('invalidates the cache when the effective browser changes', async () => {
      const cached = await writtenCache(services);
      mockReadFile.mockResolvedValue(JSON.stringify(cached));

      const moved = makeServices({
        resolution: {
          status: 'resolved',
          installation: makeInstallation({ canonicalPath: '/opt/other/chrome' }),
        },
      });
      const report = await doctor({ services: moved });

      expect(report.cachedFrom).toBeNull();
      expect(report.checks.find((c) => c.id === 'browser.selection')?.details).toMatchObject({
        path: '/opt/other/chrome',
      });
    });

    it('invalidates the cache when the managed installation changes', async () => {
      const cached = await writtenCache(services);
      mockReadFile.mockResolvedValue(JSON.stringify(cached));

      const installed = makeServices({
        managed: { ready: { status: 'ready', record: READY }, orphans: [] },
      });
      const report = await doctor({ services: installed });

      expect(report.cachedFrom).toBeNull();
      expect(report.checks.find((c) => c.id === 'browser.managed')?.details).toMatchObject({
        status: 'ready',
      });
    });

    it('re-runs checks when a cache entry records no browser identity at all', async () => {
      // Pre-fingerprint cache files cannot be trusted: nothing in them says
      // which browser they described.
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          generatedAt: new Date().toISOString(),
          cachedFrom: null,
          overall: 'ok' as const,
          checks: [],
        }),
      );

      const report = await doctor({ services });

      expect(report.cachedFrom).toBeNull();
      expect(report.checks.length).toBeGreaterThan(0);
    });

    it('re-runs checks when cache is stale (> 1 hour old)', async () => {
      const cached = await writtenCache(services);
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          ...cached,
          generatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        }),
      );

      const report = await doctor({ services });
      expect(report.cachedFrom).toBeNull(); // fresh run
      expect(services.resolver.resolve).toHaveBeenCalled();
    });

    it('refresh:true bypasses cache', async () => {
      const cachedReport = {
        generatedAt: new Date().toISOString(),
        cachedFrom: null,
        overall: 'ok' as const,
        checks: [],
      };
      mockReadFile.mockResolvedValue(JSON.stringify(cachedReport));

      await doctor({ refresh: true, services });
      expect(services.resolver.resolve).toHaveBeenCalled(); // ran fresh
    });

    it('degrades gracefully when cache write fails', async () => {
      mockWriteFile.mockRejectedValue(new Error('EROFS'));
      // Should still return a valid report
      const report = await doctor({ refresh: true, services });
      expect(report.overall).toBeDefined();
    });
  });

  describe('doctor never throws (property test)', () => {
    it('returns DoctorReport even when every check throws internally', async () => {
      // Make everything throw
      services = makeServices({ resolveError: new Error('total failure') });
      mockAccess.mockRejectedValue(new Error('total failure'));
      mockStat.mockRejectedValue(new Error('total failure'));
      keytarMocks.default.setPassword.mockRejectedValue(new Error('total failure'));
      mockReadFile.mockRejectedValue(new Error('no cache'));

      const report = await doctor({ refresh: true, services });
      // Must be a DoctorReport — not a thrown error
      expect(report).toBeDefined();
      expect(typeof report.generatedAt).toBe('string');
      expect(typeof report.overall).toBe('string');
    });

    it('fast-check: never throws regardless of random failure injection', () =>
      fc.assert(
        fc.asyncProperty(
          fc.boolean(), // whether to fail detect
          fc.boolean(), // whether to fail access
          fc.boolean(), // whether to fail keychain
          async (failDetect, failAccess, failKeychain) => {
            vi.clearAllMocks();
            mockReadFile.mockRejectedValue(new Error('no cache'));
            mockWriteFile.mockResolvedValue(undefined);
            mockMkdir.mockResolvedValue(undefined as unknown as string);

            services = failDetect
              ? makeServices({ resolveError: new Error('injected failure') })
              : makeServices({
                  evidence: { state: 'evidence', result: passingEvidence(makeInstallation()) },
                });
            if (failAccess) {
              mockAccess.mockRejectedValue(new Error('injected failure'));
            } else {
              mockAccess.mockResolvedValue(undefined);
            }
            mockStat.mockResolvedValue({ isDirectory: () => true, mode: 0o700 } as Awaited<
              ReturnType<typeof mockStat>
            >);
            if (failKeychain) {
              keytarMocks.default.setPassword.mockRejectedValue(new Error('injected failure'));
            } else {
              keytarMocks.default.setPassword.mockResolvedValue(undefined);
              keytarMocks.default.getPassword.mockResolvedValue('ok');
              keytarMocks.default.deletePassword.mockResolvedValue(true);
            }

            // Must NEVER throw
            const report = await doctor({ refresh: true, services });
            expect(report).toBeDefined();
            expect(['ok', 'warn', 'error']).toContain(report.overall);
          },
        ),
        { numRuns: 20 },
      ));
  });
});
