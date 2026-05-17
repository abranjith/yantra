/**
 * TASK-010: Security hardening tests.
 * Covers: profile-dir permission enforcement, doctor permission reporting,
 * and launcher logging redaction.
 */
import { chmod, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProfilePathRefusedError } from '../../src/browser/errors.js';

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
vi.mock('node:crypto', () => ({
  randomUUID: vi.fn(() => 'security-test-uuid'),
}));
vi.mock('../../src/browser/paths.js', () => ({
  dataDir: vi.fn(() => '/home/testuser/.local/share/yantra'),
  cacheDir: vi.fn(() => '/home/testuser/.cache/yantra'),
  profilesRoot: vi.fn(() => '/home/testuser/.local/share/yantra/profiles'),
  ephemeralRoot: vi.fn(() => '/tmp'),
  doctorCachePath: vi.fn(() => '/home/testuser/.cache/yantra/doctor.json'),
}));
vi.mock('../../src/browser/chrome-discovery.js', () => ({
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
    it('info-level logs do not contain profile path or --user-data-dir', async () => {
      const logs: string[] = [];
      const { LocalBrowserProvider } = await import('../../src/browser/provider.js');
      const { LocalProfileStore } = await import('../../src/browser/profile-store.js');

      const mockLogger = {
        info: (_: unknown, msg?: string) => logs.push(`info:${msg ?? ''}`),
        warn: (_: unknown, msg?: string) => logs.push(`warn:${msg ?? ''}`),
        error: (_: unknown, msg?: string) => logs.push(`error:${msg ?? ''}`),
        debug: (_: unknown, msg?: string) => logs.push(`debug:${msg ?? ''}`),
      };

      // Mock the launcher so we don't actually start Chrome
      vi.mock('../../src/browser/launcher.js', () => ({
        launchChrome: vi.fn().mockResolvedValue({
          browser: {
            process: vi.fn().mockReturnValue({ pid: 1, kill: vi.fn(), on: vi.fn(), stderr: null }),
            close: vi.fn().mockResolvedValue(undefined),
            newPage: vi.fn(),
            on: vi.fn(),
          },
          child: { pid: 1, kill: vi.fn(), on: vi.fn(), stderr: null, killed: false },
        }),
        buildLaunchArgs: vi.fn(() => []),
      }));

      const store = new LocalProfileStore();
      const provider = new LocalBrowserProvider({ profileStore: store, logger: mockLogger });

      try {
        await provider.launch({ profile: { kind: 'ephemeral' } });
      } catch {
        // may fail since session.ts also runs — that's ok for this test
      }

      const infoLogs = logs.filter((l) => l.startsWith('info:'));
      for (const log of infoLogs) {
        expect(log).not.toContain('--user-data-dir');
        expect(log).not.toContain('/tmp/yantra-'); // actual profile path
      }
    });
  });
});
