/**
 * TASK-010: Security hardening tests.
 * Covers: profile-dir permission enforcement, doctor permission reporting,
 * and launcher logging redaction.
 */
import type * as NodeCrypto from 'node:crypto';
import { chmod, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ChromeDiscovery from '../../src/browser/chrome-discovery.js';
import { ProfilePathRefusedError } from '../../src/browser/errors.js';
import type {
  CompatibilityResult,
  ResolvedBrowserInstallation,
} from '../../src/browser/installation-types.js';
import type * as Paths from '../../src/browser/paths.js';

vi.mock('node:fs/promises', () => ({
  access: vi.fn(),
  chmod: vi.fn(),
  mkdir: vi.fn(),
  readdir: vi.fn(),
  rm: vi.fn(),
  stat: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  constants: { W_OK: 2 },
}));
vi.mock('node:os', () => ({
  homedir: vi.fn(() => '/home/testuser'),
  tmpdir: vi.fn(() => '/tmp'),
}));
// Partial: the provider hashes the executable path with `createHash`, and a
// wholesale replacement here makes that read as a missing export.
vi.mock('node:crypto', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeCrypto>()),
  randomUUID: vi.fn(() => 'security-test-uuid'),
}));
// Partial mock: replacing the module wholesale breaks every consumer of an
// export this list forgets — memory records exactly that failure mode.
vi.mock('../../src/browser/paths.js', async (importOriginal) => ({
  ...(await importOriginal<typeof Paths>()),
  dataDir: vi.fn(() => '/home/testuser/.local/share/yantra'),
  cacheDir: vi.fn(() => '/home/testuser/.cache/yantra'),
  profilesRoot: vi.fn(() => '/home/testuser/.local/share/yantra/profiles'),
  ephemeralRoot: vi.fn(() => '/tmp'),
  doctorCachePath: vi.fn(() => '/home/testuser/.cache/yantra/doctor.json'),
}));
// Only `detectChrome` is stubbed; `chromeUserDataRoots` — the source of the
// refused-path guard's roots — must stay real for these tests to mean anything.
vi.mock('../../src/browser/chrome-discovery.js', async (importOriginal) => ({
  ...(await importOriginal<typeof ChromeDiscovery>()),
  detectChrome: vi.fn().mockResolvedValue({
    path: '/usr/bin/google-chrome',
    version: '124.0.0.0',
    majorVersion: 124,
    channel: 'stable',
    source: 'system',
  }),
}));
vi.mock('keytar', () => ({
  default: {
    setPassword: vi.fn().mockResolvedValue(undefined),
    getPassword: vi.fn().mockResolvedValue('ok'),
    deletePassword: vi.fn().mockResolvedValue(true),
  },
}));

const mockChmod = vi.mocked(chmod);
const mockStat = vi.mocked(stat);
const mockAccess = vi.mocked(await import('node:fs/promises').then((m) => m.access));
const mockMkdir = vi.mocked(await import('node:fs/promises').then((m) => m.mkdir));
const mockReaddir = vi.mocked(await import('node:fs/promises').then((m) => m.readdir));
const mockReadFile = vi.mocked(await import('node:fs/promises').then((m) => m.readFile));
const mockWriteFile = vi.mocked(await import('node:fs/promises').then((m) => m.writeFile));

describe('@no-llm TASK-010 security hardening', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process, 'platform', { value: 'linux', writable: true });
    mockAccess.mockResolvedValue(undefined);
    mockChmod.mockResolvedValue(undefined);
    mockMkdir.mockResolvedValue(undefined as unknown as string);
    mockStat.mockResolvedValue({
      isDirectory: () => true,
      mode: 0o700,
      size: 0,
      mtime: new Date(),
    } as Awaited<ReturnType<typeof stat>>);
    mockReaddir.mockResolvedValue([] as unknown as Awaited<ReturnType<typeof mockReaddir>>);
    mockReadFile.mockRejectedValue(new Error('ENOENT'));
    mockWriteFile.mockResolvedValue(undefined);
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true });
  });

  describe('profile-dir permission enforcement', () => {
    it('profile dir mode is corrected to 0700 after creation on Unix', async () => {
      const { LocalProfileStore } = await import('../../src/browser/profile-store.js');
      mockAccess.mockRejectedValueOnce(new Error('ENOENT')); // dir does not exist yet

      const store = new LocalProfileStore();
      await store.resolve({ kind: 'workflow', workflowName: 'test-wf' });

      expect(mockChmod).toHaveBeenCalledWith(
        join('/home/testuser/.local/share/yantra', 'profiles', 'test-wf'),
        0o700,
      );
    });

    it('refused-path guard fires for the macOS Chrome profile', async () => {
      const { LocalProfileStore } = await import('../../src/browser/profile-store.js');
      const { homedir } = await import('node:os');
      vi.mocked(homedir).mockReturnValue('/Users/testmac');

      const store = new LocalProfileStore();
      await expect(
        store.resolve({
          kind: 'explicit',
          absolutePath: '/Users/testmac/Library/Application Support/Google/Chrome/Default',
        }),
      ).rejects.toThrow(ProfilePathRefusedError);
    });

    it('refused-path guard fires for the Linux Chrome config dir', async () => {
      const { LocalProfileStore } = await import('../../src/browser/profile-store.js');
      const { homedir } = await import('node:os');
      vi.mocked(homedir).mockReturnValue('/home/user');

      const store = new LocalProfileStore();
      await expect(
        store.resolve({
          kind: 'explicit',
          absolutePath: '/home/user/.config/google-chrome/Default',
        }),
      ).rejects.toThrow(ProfilePathRefusedError);
    });
  });

  describe('doctor permission check walks profile subdirs', () => {
    it('warns when a workflow profile dir has 0755 mode', async () => {
      const { doctor } = await import('../../src/browser/doctor.js');
      mockReaddir.mockResolvedValue(['my-workflow'] as unknown as Awaited<
        ReturnType<typeof mockReaddir>
      >);
      mockStat.mockImplementation(async (p: unknown) => {
        if (String(p).includes('my-workflow')) {
          return { isDirectory: () => true, mode: 0o755 } as Awaited<ReturnType<typeof stat>>;
        }
        return { isDirectory: () => true, mode: 0o700 } as Awaited<ReturnType<typeof stat>>;
      });

      const report = await doctor({ refresh: true });
      const check = report.checks.find((c) => c.id === 'datadir.permissions');
      expect(check?.status).toBe('warn');
      expect((check?.details['offenders'] as string[]).some((o) => o.includes('my-workflow'))).toBe(
        true,
      );
    });

    it('returns ok when all dirs are 0700', async () => {
      const { doctor } = await import('../../src/browser/doctor.js');
      mockReaddir.mockResolvedValue(['wf-one', 'wf-two'] as unknown as Awaited<
        ReturnType<typeof mockReaddir>
      >);
      mockStat.mockResolvedValue({ isDirectory: () => true, mode: 0o700 } as Awaited<
        ReturnType<typeof stat>
      >);

      const report = await doctor({ refresh: true });
      const check = report.checks.find((c) => c.id === 'datadir.permissions');
      expect(check?.status).toBe('ok');
    });
  });

  describe('launcher log redaction', () => {
    it('info-level logs do not contain the profile path or launch arguments', async () => {
      const logs: string[] = [];
      const { LocalBrowserProvider } = await import('../../src/browser/provider.js');
      const { LocalProfileStore } = await import('../../src/browser/profile-store.js');
      const launcher = await import('../../src/browser/launcher.js');
      const resolverModule = await import('../../src/browser/browser-resolver.js');

      const mockLogger = {
        info: (obj: unknown, msg?: string) => logs.push(`info:${JSON.stringify(obj)} ${msg ?? ''}`),
        warn: () => undefined,
        error: () => undefined,
        debug: () => undefined,
      };

      // Stub the one launch seam so no browser starts, while every log the
      // provider emits on the way there is captured verbatim.
      const launched = {
        browser: { on: vi.fn(), pages: vi.fn(), close: vi.fn() },
        child: { pid: 1, on: vi.fn(), stderr: null },
        supervisor: { hasExited: () => false },
        ownership: { kind: 'external' as const },
        shutdown: vi.fn().mockResolvedValue(undefined),
      };
      vi.spyOn(launcher, 'launchResolvedChrome').mockResolvedValue(
        launched as unknown as Awaited<ReturnType<typeof launcher.launchResolvedChrome>>,
      );
      // node:fs/promises is mocked wholesale in this suite, so the provider's
      // re-stat needs its own boundary stub.
      vi.spyOn(resolverModule, 'identifyExecutable').mockImplementation((path) =>
        Promise.resolve({
          canonicalPath: path,
          version: '153.0.8010.36',
          majorVersion: 153,
          platform: 'linux',
          architecture: 'x64',
          statFingerprint: '1:2:3:4',
        }),
      );

      const installation = {
        canonicalPath: '/usr/bin/google-chrome',
        version: '153.0.8010.36',
        majorVersion: 153,
        platform: 'linux' as const,
        architecture: 'x64',
        statFingerprint: '1:2:3:4',
        ownership: 'external' as const,
        requestedSelection: { source: 'auto' as const, executablePath: null },
        selectionOrigin: 'default' as const,
        selectionReason: 'system-discovery' as const,
        channel: 'stable' as const,
        managedIdentity: null,
      };
      const provider = new LocalBrowserProvider({
        profileStore: new LocalProfileStore(),
        logger: mockLogger,
        services: {
          resolver: { resolve: () => Promise.resolve({ status: 'resolved', installation }) },
          compatibility: {
            check: () => Promise.resolve(passingEvidence(installation)),
            decide: () =>
              Promise.resolve({
                result: passingEvidence(installation),
                evidenceSource: 'probe' as const,
              }),
            readCached: () => Promise.resolve({ state: 'unverified' }),
          },
          coordinator: {
            reserveUse: vi.fn(),
            claimMutation: vi.fn(),
            hasActiveUse: () => Promise.resolve(false),
          },
          managedState: {
            readReady: () => Promise.resolve({ status: 'absent' }),
            readInventory: () => Promise.resolve({ ready: { status: 'absent' }, orphans: [] }),
          },
        } as never,
      });

      await provider.launch({ profile: { kind: 'ephemeral' } });

      const infoLogs = logs.filter((l) => l.startsWith('info:'));
      expect(infoLogs.length).toBeGreaterThan(0);
      for (const log of infoLogs) {
        expect(log).not.toContain('--user-data-dir');
        expect(log).not.toContain('--no-first-run');
        expect(log).not.toContain('/tmp/yantra-');
      }
    });
  });
});

/** One passing verdict, shared by the `check`/`decide` projections of the double. */
function passingEvidence(target: ResolvedBrowserInstallation): CompatibilityResult {
  return {
    schemaVersion: 1,
    identity: target,
    driverVersion: '25.10.0',
    testedBuild: '152.0.7977.75',
    probeRevision: 1,
    capabilityTableHash: 'hash',
    profile: 'automation',
    checkedAt: '2026-09-13T00:00:00.000Z',
    capabilities: [],
    verdict: { status: 'passed', pairing: 'capability-checked' },
  };
}
