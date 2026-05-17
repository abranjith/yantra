import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  cacheDir,
  dataDir,
  doctorCachePath,
  ephemeralRoot,
  profilesRoot,
} from '../../src/browser/paths.js';

vi.mock('node:os', () => ({
  homedir: vi.fn(() => '/home/testuser'),
  tmpdir: vi.fn(() => '/tmp'),
}));

const mockHomedir = vi.mocked(homedir);
const mockTmpdir = vi.mocked(tmpdir);

describe('@no-llm paths', () => {
  const originalPlatform = process.platform;
  const savedEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...savedEnv };
    mockHomedir.mockReturnValue('/home/testuser');
    mockTmpdir.mockReturnValue('/tmp');
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true });
    process.env = savedEnv;
  });

  function setPlatform(platform: string): void {
    Object.defineProperty(process, 'platform', { value: platform, writable: true });
  }

  describe('dataDir', () => {
    it('uses XDG_DATA_HOME when set on Linux', () => {
      setPlatform('linux');
      process.env['XDG_DATA_HOME'] = '/custom/data';
      expect(dataDir()).toBe(join('/custom/data', 'yantra'));
    });

    it('falls back to ~/.local/share/yantra on Linux', () => {
      setPlatform('linux');
      delete process.env['XDG_DATA_HOME'];
      expect(dataDir()).toBe(join('/home/testuser', '.local', 'share', 'yantra'));
    });

    it('uses %LOCALAPPDATA%\\yantra on Windows', () => {
      setPlatform('win32');
      process.env['LOCALAPPDATA'] = 'C:\\Users\\test\\AppData\\Local';
      expect(dataDir()).toBe(join('C:\\Users\\test\\AppData\\Local', 'yantra'));
    });

    it('falls back to AppData\\Local on Windows when LOCALAPPDATA unset', () => {
      setPlatform('win32');
      delete process.env['LOCALAPPDATA'];
      mockHomedir.mockReturnValue('C:\\Users\\test');
      expect(dataDir()).toBe(join('C:\\Users\\test', 'AppData', 'Local', 'yantra'));
    });

    it('uses XDG_DATA_HOME on macOS too', () => {
      setPlatform('darwin');
      process.env['XDG_DATA_HOME'] = '/mac/custom';
      expect(dataDir()).toBe(join('/mac/custom', 'yantra'));
    });
  });

  describe('cacheDir', () => {
    it('uses XDG_CACHE_HOME when set on Linux', () => {
      setPlatform('linux');
      process.env['XDG_CACHE_HOME'] = '/custom/cache';
      expect(cacheDir()).toBe(join('/custom/cache', 'yantra'));
    });

    it('falls back to ~/.cache/yantra on Linux', () => {
      setPlatform('linux');
      delete process.env['XDG_CACHE_HOME'];
      expect(cacheDir()).toBe(join('/home/testuser', '.cache', 'yantra'));
    });

    it('uses %LOCALAPPDATA%\\yantra\\Cache on Windows', () => {
      setPlatform('win32');
      process.env['LOCALAPPDATA'] = 'C:\\Users\\test\\AppData\\Local';
      expect(cacheDir()).toBe(join('C:\\Users\\test\\AppData\\Local', 'yantra', 'Cache'));
    });
  });

  describe('profilesRoot', () => {
    it('is a profiles subdirectory of dataDir', () => {
      setPlatform('linux');
      delete process.env['XDG_DATA_HOME'];
      expect(profilesRoot()).toBe(join('/home/testuser', '.local', 'share', 'yantra', 'profiles'));
    });
  });

  describe('ephemeralRoot', () => {
    it('returns OS tmpdir', () => {
      expect(ephemeralRoot()).toBe('/tmp');
    });
  });

  describe('doctorCachePath', () => {
    it('is doctor.json inside cacheDir', () => {
      setPlatform('linux');
      delete process.env['XDG_CACHE_HOME'];
      expect(doctorCachePath()).toBe(join('/home/testuser', '.cache', 'yantra', 'doctor.json'));
    });

    it('uses XDG_CACHE_HOME when set', () => {
      setPlatform('linux');
      process.env['XDG_CACHE_HOME'] = '/xdg/cache';
      expect(doctorCachePath()).toBe(join('/xdg/cache', 'yantra', 'doctor.json'));
    });
  });

  // Satisfy linting
  it('tmpdir mock is used', () => {
    expect(mockTmpdir()).toBe('/tmp');
  });
});
