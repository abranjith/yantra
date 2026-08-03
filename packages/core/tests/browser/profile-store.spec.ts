import { access, chmod, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProfilePathRefusedError } from '../../src/browser/errors.js';
import { LocalProfileStore } from '../../src/browser/profile-store.js';

vi.mock('node:fs/promises', () => ({
  access: vi.fn(),
  chmod: vi.fn(),
  mkdir: vi.fn(),
  readdir: vi.fn(),
  rm: vi.fn(),
  stat: vi.fn(),
}));
vi.mock('node:os', () => ({
  homedir: vi.fn(() => '/home/testuser'),
  tmpdir: vi.fn(() => '/tmp'),
}));
vi.mock('node:crypto', () => ({
  randomUUID: vi.fn(() => 'test-uuid-1234'),
}));
vi.mock('../../src/browser/paths.js', () => ({
  dataDir: vi.fn(() => '/home/testuser/.local/share/yantra'),
  ephemeralRoot: vi.fn(() => '/tmp'),
}));

const mockAccess = vi.mocked(access);
const mockChmod = vi.mocked(chmod);
const mockMkdir = vi.mocked(mkdir);
const mockReaddir = vi.mocked(readdir);
const mockRm = vi.mocked(rm);
const mockStat = vi.mocked(stat);

function makeDirStat(mtime = new Date('2024-01-01')): Awaited<ReturnType<typeof stat>> {
  return {
    isDirectory: () => true,
    size: 1024,
    mtime,
    mode: 0o700,
  } as Awaited<ReturnType<typeof stat>>;
}

describe('@no-llm LocalProfileStore', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process, 'platform', { value: 'linux', writable: true });
    mockAccess.mockResolvedValue(undefined);
    mockChmod.mockResolvedValue(undefined);
    mockMkdir.mockResolvedValue(undefined as unknown as string);
    mockRm.mockResolvedValue(undefined);
    mockStat.mockResolvedValue(makeDirStat());
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true });
  });

  describe('resolve: workflow', () => {
    it('resolves workflow profile to expected path', async () => {
      mockAccess.mockRejectedValueOnce(new Error('ENOENT')); // dir doesn't exist yet
      const store = new LocalProfileStore();
      const result = await store.resolve({ kind: 'workflow', workflowName: 'my-workflow' });

      expect(result.absolutePath).toBe(
        join('/home/testuser/.local/share/yantra', 'profiles', 'my-workflow'),
      );
      expect(result.kind).toBe('workflow');
    });

    it('sets createdNow=true when directory is created fresh', async () => {
      mockAccess.mockRejectedValueOnce(new Error('ENOENT'));
      const store = new LocalProfileStore();
      const result = await store.resolve({ kind: 'workflow', workflowName: 'new-wf' });
      expect(result.createdNow).toBe(true);
    });

    it('sets createdNow=false when directory already exists', async () => {
      mockAccess.mockResolvedValue(undefined); // dir exists
      const store = new LocalProfileStore();
      const result = await store.resolve({ kind: 'workflow', workflowName: 'existing-wf' });
      expect(result.createdNow).toBe(false);
    });

    it('rejects workflow name with path traversal', async () => {
      const store = new LocalProfileStore();
      await expect(store.resolve({ kind: 'workflow', workflowName: '../etc' })).rejects.toThrow(
        ProfilePathRefusedError,
      );
    });

    it('rejects workflow name with spaces', async () => {
      const store = new LocalProfileStore();
      await expect(
        store.resolve({ kind: 'workflow', workflowName: 'Bank Workflow' }),
      ).rejects.toThrow(ProfilePathRefusedError);
    });

    it('rejects empty workflow name', async () => {
      const store = new LocalProfileStore();
      await expect(store.resolve({ kind: 'workflow', workflowName: '' })).rejects.toThrow(
        ProfilePathRefusedError,
      );
    });

    it('calls chmod 0700 on Unix', async () => {
      mockAccess.mockRejectedValueOnce(new Error('ENOENT'));
      const store = new LocalProfileStore();
      await store.resolve({ kind: 'workflow', workflowName: 'my-wf' });
      expect(mockChmod).toHaveBeenCalledWith(
        join('/home/testuser/.local/share/yantra', 'profiles', 'my-wf'),
        0o700,
      );
    });

    it('skips chmod on Windows', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32', writable: true });
      mockAccess.mockRejectedValueOnce(new Error('ENOENT'));
      const store = new LocalProfileStore();
      await store.resolve({ kind: 'workflow', workflowName: 'my-wf' });
      expect(mockChmod).not.toHaveBeenCalled();
    });
  });

  describe('resolve: ephemeral', () => {
    it('creates a uniquely named ephemeral dir', async () => {
      const store = new LocalProfileStore();
      const result = await store.resolve({ kind: 'ephemeral' });

      expect(result.absolutePath).toContain('yantra-');
      expect(result.kind).toBe('ephemeral');
      expect(result.createdNow).toBe(true);
    });

    it('calls mkdir for ephemeral dir', async () => {
      const store = new LocalProfileStore();
      await store.resolve({ kind: 'ephemeral' });
      expect(mockMkdir).toHaveBeenCalledWith(
        expect.stringContaining('yantra-'),
        expect.objectContaining({ recursive: true }),
      );
    });
  });

  describe('resolve: explicit', () => {
    it('accepts valid absolute path that exists as a directory', async () => {
      const store = new LocalProfileStore();
      const result = await store.resolve({
        kind: 'explicit',
        absolutePath: '/profiles/my-profile',
      });
      expect(result.absolutePath).toBe('/profiles/my-profile');
      expect(result.kind).toBe('explicit');
      expect(result.createdNow).toBe(false);
    });

    it('rejects relative path', async () => {
      const store = new LocalProfileStore();
      await expect(
        store.resolve({ kind: 'explicit', absolutePath: 'relative/path' }),
      ).rejects.toThrow(ProfilePathRefusedError);
    });

    it('rejects path that is not a directory', async () => {
      mockStat.mockResolvedValue({
        isDirectory: () => false,
        size: 0,
        mtime: new Date(),
        mode: 0o600,
      } as Awaited<ReturnType<typeof stat>>);
      const store = new LocalProfileStore();
      await expect(
        store.resolve({ kind: 'explicit', absolutePath: '/path/to/file.txt' }),
      ).rejects.toThrow(ProfilePathRefusedError);
    });
  });

  describe('refused-path guard', () => {
    it('refuses macOS Chrome profile root', async () => {
      vi.mocked(homedir).mockReturnValue('/Users/test');
      const store = new LocalProfileStore();
      const chromePath = '/Users/test/Library/Application Support/Google/Chrome/Profile 1';

      await expect(store.resolve({ kind: 'explicit', absolutePath: chromePath })).rejects.toThrow(
        ProfilePathRefusedError,
      );
    });

    it('refuses Linux Chrome config dir', async () => {
      vi.mocked(homedir).mockReturnValue('/home/user');
      const store = new LocalProfileStore();

      await expect(
        store.resolve({
          kind: 'explicit',
          absolutePath: '/home/user/.config/google-chrome/Default',
        }),
      ).rejects.toThrow(ProfilePathRefusedError);
    });

    it('refuses Windows Chrome User Data (case-sensitive path check)', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32', writable: true });
      process.env['LOCALAPPDATA'] = 'C:\\Users\\test\\AppData\\Local';
      const store = new LocalProfileStore();

      await expect(
        store.resolve({
          kind: 'explicit',
          absolutePath: 'C:\\Users\\test\\AppData\\Local\\Google\\Chrome\\User Data\\Default',
        }),
      ).rejects.toThrow(ProfilePathRefusedError);
    });
  });

  describe('cleanupEphemeral', () => {
    it('removes the directory', async () => {
      const store = new LocalProfileStore();
      await store.cleanupEphemeral('/tmp/yantra-test-uuid');
      expect(mockRm).toHaveBeenCalledWith('/tmp/yantra-test-uuid', {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    });

    it('is idempotent — does not throw when directory does not exist', async () => {
      mockRm.mockRejectedValue({ code: 'ENOENT' });
      const store = new LocalProfileStore();
      // Should not throw
      await expect(store.cleanupEphemeral('/nonexistent')).resolves.toBeUndefined();
    });

    it('survives EBUSY (Chrome still holds lock)', async () => {
      const err = Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
      mockRm.mockRejectedValue(err);
      const store = new LocalProfileStore();
      await expect(store.cleanupEphemeral('/tmp/yantra-locked')).resolves.toBeUndefined();
    });
  });

  describe('listWorkflowProfiles', () => {
    it('returns profiles sorted by lastModified desc', async () => {
      const profiles = ['wf-a', 'wf-b', 'wf-c'];
      mockReaddir.mockResolvedValue(profiles as unknown as Awaited<ReturnType<typeof readdir>>);
      mockStat
        .mockResolvedValueOnce(makeDirStat(new Date('2024-03-01')))
        .mockResolvedValueOnce(makeDirStat(new Date('2024-01-01')))
        .mockResolvedValueOnce(makeDirStat(new Date('2024-02-01')));

      const store = new LocalProfileStore();
      const result = await store.listWorkflowProfiles();

      expect(result.map((r) => r.workflowName)).toEqual(['wf-a', 'wf-c', 'wf-b']);
    });

    it('returns empty array when profiles root does not exist', async () => {
      mockReaddir.mockRejectedValue(new Error('ENOENT'));
      const store = new LocalProfileStore();
      const result = await store.listWorkflowProfiles();
      expect(result).toEqual([]);
    });
  });
});
