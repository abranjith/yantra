import * as fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { doctor } from '../../src/browser/doctor.js';

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
vi.mock('../../src/browser/paths.js', () => ({
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

function makeChrome(majorVersion = 124) {
  return {
    path: '/usr/bin/google-chrome',
    version: `${majorVersion}.0.0.0`,
    majorVersion,
    channel: 'stable' as const,
    source: 'system' as const,
  };
}

describe('@no-llm doctor', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process, 'platform', { value: 'linux', writable: true });

    // Default: happy path
    mockDetectChrome.mockReturnValue(makeChrome(124));
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
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true });
  });

  describe('overall: all checks pass', () => {
    it('returns overall=ok when everything passes', async () => {
      const report = await doctor({ refresh: true });
      expect(report.overall).toBe('ok');
      expect(report.checks).toHaveLength(6);
    });

    it('has a valid ISO-8601 generatedAt', async () => {
      const report = await doctor({ refresh: true });
      expect(new Date(report.generatedAt).toISOString()).toBe(report.generatedAt);
    });

    it('sets cachedFrom=null on fresh run', async () => {
      const report = await doctor({ refresh: true });
      expect(report.cachedFrom).toBeNull();
    });
  });

  describe('chrome.detected check', () => {
    it('returns ok when Chrome is found', async () => {
      const report = await doctor({ refresh: true });
      const check = report.checks.find((c) => c.id === 'chrome.detected');
      expect(check?.status).toBe('ok');
    });

    it('returns error when Chrome is not found', async () => {
      mockDetectChrome.mockReturnValue(null);
      const report = await doctor({ refresh: true });
      const check = report.checks.find((c) => c.id === 'chrome.detected');
      expect(check?.status).toBe('error');
      expect(check?.fixHint).toContain('google.com');
    });

    it('sets overall=error when Chrome not found', async () => {
      mockDetectChrome.mockReturnValue(null);
      const report = await doctor({ refresh: true });
      expect(report.overall).toBe('error');
    });
  });

  describe('chrome.version_min check', () => {
    it('returns ok when Chrome version meets minimum', async () => {
      const report = await doctor({ refresh: true });
      const check = report.checks.find((c) => c.id === 'chrome.version_min');
      expect(check?.status).toBe('ok');
    });

    it('returns error when Chrome version is too old', async () => {
      mockDetectChrome.mockReturnValue(makeChrome(100));
      const report = await doctor({ refresh: true });
      const check = report.checks.find((c) => c.id === 'chrome.version_min');
      expect(check?.status).toBe('error');
    });

    it('returns warn when Chrome was not detected', async () => {
      mockDetectChrome
        .mockReturnValueOnce(null) // first call: chrome.detected
        .mockReturnValueOnce(null); // second call: version check
      const report = await doctor({ refresh: true });
      const check = report.checks.find((c) => c.id === 'chrome.version_min');
      expect(check?.status).toBe('warn');
    });
  });

  describe('datadir.writable check', () => {
    it('returns ok when dir is writable', async () => {
      const report = await doctor({ refresh: true });
      const check = report.checks.find((c) => c.id === 'datadir.writable');
      expect(check?.status).toBe('ok');
    });

    it('returns error when dir is not writable', async () => {
      mockAccess.mockRejectedValue(new Error('EACCES'));
      mockMkdir.mockRejectedValue(new Error('EACCES'));
      const report = await doctor({ refresh: true });
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
      const report = await doctor({ refresh: true });
      const check = report.checks.find((c) => c.id === 'datadir.permissions');
      expect(check?.status).toBe('ok');
    });

    it('returns warn when mode is 0755', async () => {
      mockStat.mockResolvedValue({
        isDirectory: () => true,
        mode: 0o755,
      } as Awaited<ReturnType<typeof mockStat>>);
      const report = await doctor({ refresh: true });
      const check = report.checks.find((c) => c.id === 'datadir.permissions');
      expect(check?.status).toBe('warn');
    });

    it('returns ok with note on Windows', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32', writable: true });
      const report = await doctor({ refresh: true });
      const check = report.checks.find((c) => c.id === 'datadir.permissions');
      expect(check?.status).toBe('ok');
      expect(check?.details['note']).toBeTruthy();
    });
  });

  describe('cachedir.writable check', () => {
    it('returns ok when cache dir is writable', async () => {
      const report = await doctor({ refresh: true });
      const check = report.checks.find((c) => c.id === 'cachedir.writable');
      expect(check?.status).toBe('ok');
    });
  });

  describe('keychain.reachable check', () => {
    it('returns ok on successful round-trip', async () => {
      const report = await doctor({ refresh: true });
      const check = report.checks.find((c) => c.id === 'keychain.reachable');
      expect(check?.status).toBe('ok');
    });

    it('returns error when keytar throws', async () => {
      keytarMocks.default.setPassword.mockRejectedValue(new Error('keychain locked'));
      const report = await doctor({ refresh: true });
      const check = report.checks.find((c) => c.id === 'keychain.reachable');
      expect(check?.status).toBe('error');
    });

    it('returns error when round-trip value does not match', async () => {
      keytarMocks.default.getPassword.mockResolvedValue('wrong-value');
      const report = await doctor({ refresh: true });
      const check = report.checks.find((c) => c.id === 'keychain.reachable');
      expect(check?.status).toBe('error');
    });
  });

  describe('cache behavior', () => {
    it('serves cached report when TTL has not expired', async () => {
      const freshReport = {
        generatedAt: new Date().toISOString(),
        cachedFrom: null,
        overall: 'ok' as const,
        checks: [],
      };
      mockReadFile.mockResolvedValue(JSON.stringify(freshReport));

      const report = await doctor();
      expect(report.cachedFrom).toBe(freshReport.generatedAt);
      expect(mockDetectChrome).not.toHaveBeenCalled();
    });

    it('re-runs checks when cache is stale (> 1 hour old)', async () => {
      const staleReport = {
        generatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        cachedFrom: null,
        overall: 'ok' as const,
        checks: [],
      };
      mockReadFile.mockResolvedValue(JSON.stringify(staleReport));

      const report = await doctor();
      expect(report.cachedFrom).toBeNull(); // fresh run
      expect(mockDetectChrome).toHaveBeenCalled();
    });

    it('refresh:true bypasses cache', async () => {
      const cachedReport = {
        generatedAt: new Date().toISOString(),
        cachedFrom: null,
        overall: 'ok' as const,
        checks: [],
      };
      mockReadFile.mockResolvedValue(JSON.stringify(cachedReport));

      await doctor({ refresh: true });
      expect(mockDetectChrome).toHaveBeenCalled(); // ran fresh
    });

    it('degrades gracefully when cache write fails', async () => {
      mockWriteFile.mockRejectedValue(new Error('EROFS'));
      // Should still return a valid report
      const report = await doctor({ refresh: true });
      expect(report.overall).toBeDefined();
    });
  });

  describe('doctor never throws (property test)', () => {
    it('returns DoctorReport even when every check throws internally', async () => {
      // Make everything throw
      mockDetectChrome.mockRejectedValue(new Error('total failure'));
      mockAccess.mockRejectedValue(new Error('total failure'));
      mockStat.mockRejectedValue(new Error('total failure'));
      keytarMocks.default.setPassword.mockRejectedValue(new Error('total failure'));
      mockReadFile.mockRejectedValue(new Error('no cache'));

      const report = await doctor({ refresh: true });
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

            if (failDetect) {
              mockDetectChrome.mockRejectedValue(new Error('injected failure'));
            } else {
              mockDetectChrome.mockReturnValue(makeChrome(124));
            }
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
            const report = await doctor({ refresh: true });
            expect(report).toBeDefined();
            expect(['ok', 'warn', 'error']).toContain(report.overall);
          },
        ),
        { numRuns: 20 },
      ));
  });
});
