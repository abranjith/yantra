import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  cacheDir,
  configPath,
  dataDir,
  doctorCachePath,
  ephemeralRoot,
  profilesRoot,
  resetPathCache,
  runsRoot,
  templatesRoot,
  workflowsRoot,
  yantraHome,
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
    delete process.env.YANTRA_HOME;
    resetPathCache();
    mockHomedir.mockReturnValue('/home/testuser');
    mockTmpdir.mockReturnValue('/tmp');
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true });
    process.env = savedEnv;
    resetPathCache();
  });

  function setPlatform(platform: string): void {
    Object.defineProperty(process, 'platform', { value: platform, writable: true });
  }

  it.each(['win32', 'darwin', 'linux'])('uses the same layout on %s', (platform) => {
    setPlatform(platform);
    expect(yantraHome()).toBe(join('/home/testuser', '.yantra'));
    expect(dataDir()).toBe(join('/home/testuser', '.yantra', 'data'));
    expect(cacheDir()).toBe(join('/home/testuser', '.yantra', 'cache'));
  });

  it('uses a trimmed YANTRA_HOME override', () => {
    process.env.YANTRA_HOME = '  /custom/yantra  ';
    expect(yantraHome()).toBe('/custom/yantra');
    expect(configPath()).toBe(join('/custom/yantra', 'config.yaml'));
  });

  it('ignores legacy platform directory variables', () => {
    process.env.XDG_CONFIG_HOME = '/legacy/config';
    process.env.XDG_DATA_HOME = '/legacy/data';
    process.env.XDG_CACHE_HOME = '/legacy/cache';
    process.env.LOCALAPPDATA = '/legacy/local';
    process.env.APPDATA = '/legacy/roaming';
    expect(yantraHome()).toBe(join('/home/testuser', '.yantra'));
  });

  it('places derived roots below home and data', () => {
    const home = yantraHome();
    const data = dataDir();
    expect(configPath()).toBe(join(home, 'config.yaml'));
    expect(profilesRoot()).toBe(join(data, 'profiles'));
    expect(runsRoot()).toBe(join(data, 'runs'));
    expect(workflowsRoot()).toBe(join(data, 'workflows'));
    expect(templatesRoot()).toBe(join(data, 'templates'));
    expect(doctorCachePath()).toBe(join(cacheDir(), 'doctor.json'));
  });

  it('keeps ephemeral profiles in the OS temp directory', () => {
    expect(ephemeralRoot()).toBe('/tmp');
    expect(mockTmpdir).toHaveBeenCalled();
  });
});
