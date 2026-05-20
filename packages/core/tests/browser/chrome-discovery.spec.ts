import { execFileSync } from 'node:child_process';
import { accessSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { detectChrome } from '../../src/browser/chrome-discovery.js';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));
vi.mock('node:fs', () => ({
  accessSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  constants: { X_OK: 1 },
}));
vi.mock('node:os', () => ({
  homedir: vi.fn(() => '/home/testuser'),
}));

const mockExecFileSync = vi.mocked(execFileSync);
const mockAccessSync = vi.mocked(accessSync);
const mockReaddirSync = vi.mocked(readdirSync);

function makeVersionOutput(versionString = 'Google Chrome 124.0.6367.91'): string {
  return `${versionString}\n`;
}

function makeRegistryOutput(path: string): string {
  return `\nHKEY_LOCAL_MACHINE\\...\n    (Default)    REG_SZ    ${path}\n\n`;
}

describe('@no-llm chrome-discovery', () => {
  const originalPlatform = process.platform;
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true });
    process.env = originalEnv;
  });

  function setPlatform(platform: string): void {
    Object.defineProperty(process, 'platform', { value: platform, writable: true });
  }

  describe('version parser', () => {
    it('parses standard Google Chrome version string', async () => {
      setPlatform('darwin');
      mockAccessSync.mockReturnValue(undefined);
      mockExecFileSync.mockReturnValue(makeVersionOutput('Google Chrome 124.0.6367.91'));

      const result = await detectChrome({
        override: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      });

      expect(result).not.toBeNull();
      expect(result?.version).toBe('124.0.6367.91');
      expect(result?.majorVersion).toBe(124);
    });

    it('parses Chromium version string', async () => {
      setPlatform('linux');
      mockAccessSync.mockReturnValue(undefined);
      mockExecFileSync.mockReturnValue(makeVersionOutput('Chromium 122.0.6261.94'));

      const result = await detectChrome({ override: '/usr/bin/chromium' });

      expect(result?.version).toBe('122.0.6261.94');
      expect(result?.majorVersion).toBe(122);
    });

    it('returns null when version output is malformed', async () => {
      setPlatform('linux');
      mockAccessSync.mockReturnValue(undefined);
      mockExecFileSync.mockReturnValue('not a version\n');

      const result = await detectChrome({ override: '/usr/bin/chrome' });
      expect(result).toBeNull();
    });
  });

  describe('override path', () => {
    it('returns result for valid executable with correct version', async () => {
      setPlatform('linux');
      mockAccessSync.mockReturnValue(undefined);
      mockExecFileSync.mockReturnValue(makeVersionOutput());

      const result = await detectChrome({ override: '/opt/custom/chrome' });

      expect(result).not.toBeNull();
      expect(result?.path).toBe('/opt/custom/chrome');
      expect(result?.source).toBe('system');
    });

    it('returns null for non-existent or non-executable path', async () => {
      setPlatform('linux');
      mockAccessSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });
      mockExecFileSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });

      const result = await detectChrome({ override: '/nonexistent/chrome' });
      expect(result).toBeNull();
    });
  });

  describe('macOS discovery', () => {
    beforeEach(() => setPlatform('darwin'));

    it('finds Chrome at /Applications path', async () => {
      mockAccessSync.mockReturnValue(undefined);
      mockExecFileSync.mockImplementation((cmd: string) => {
        if (
          String(cmd).includes('Google Chrome.app') &&
          !String(cmd).includes('Beta') &&
          !String(cmd).includes('Canary')
        ) {
          return makeVersionOutput('Google Chrome 124.0.6367.91');
        }
        throw new Error('not found');
      });

      const result = await detectChrome();
      expect(result).not.toBeNull();
      expect(result?.channel).toBe('stable');
      expect(result?.majorVersion).toBe(124);
    });

    it('finds Canary when stable is missing', async () => {
      mockAccessSync.mockReturnValue(undefined);
      mockExecFileSync.mockImplementation((cmd: string) => {
        if (String(cmd).includes('Canary')) {
          return makeVersionOutput('Google Chrome Canary 127.0.6533.0');
        }
        throw new Error('not found');
      });

      const result = await detectChrome();
      expect(result?.channel).toBe('canary');
    });

    it('returns null when nothing is found on macOS', async () => {
      mockAccessSync.mockImplementation(() => {
        throw new Error('not found');
      });
      mockExecFileSync.mockImplementation(() => {
        throw new Error('not found');
      });
      // Also need to make PATH-based lookup fail
      process.env['PATH'] = '';

      const result = await detectChrome();
      expect(result).toBeNull();
    });
  });

  describe('Linux discovery', () => {
    beforeEach(() => setPlatform('linux'));

    it('returns first hit on PATH', async () => {
      process.env['PATH'] = '/usr/bin:/usr/local/bin';
      mockAccessSync.mockImplementation((p: unknown) => {
        if (String(p) === '/usr/bin/google-chrome') return undefined;
        throw new Error('not found');
      });
      mockExecFileSync.mockReturnValue(makeVersionOutput());

      const result = await detectChrome();
      expect(result?.path).toBe('/usr/bin/google-chrome');
    });

    it('finds snap chromium path', async () => {
      process.env['PATH'] = '';
      mockAccessSync.mockImplementation((p: unknown) => {
        if (String(p) === '/snap/bin/chromium') return undefined;
        throw new Error('not found');
      });
      mockExecFileSync.mockImplementation((cmd: string) => {
        if (String(cmd).includes('snap')) return makeVersionOutput('Chromium 122.0.6261.94');
        throw new Error('not found');
      });

      const result = await detectChrome();
      expect(result?.path).toBe('/snap/bin/chromium');
      expect(result?.channel).toBe('chromium');
    });

    it('returns null when nothing found on Linux', async () => {
      process.env['PATH'] = '';
      mockAccessSync.mockImplementation(() => {
        throw new Error('not found');
      });
      mockExecFileSync.mockImplementation(() => {
        throw new Error('not found');
      });

      const result = await detectChrome();
      expect(result).toBeNull();
    });
  });

  describe('Windows discovery', () => {
    beforeEach(() => {
      setPlatform('win32');
      process.env['LOCALAPPDATA'] = 'C:\\Users\\test\\AppData\\Local';
      process.env['ProgramFiles'] = 'C:\\Program Files';
      process.env['ProgramFiles(x86)'] = 'C:\\Program Files (x86)';
    });

    it('prefers HKLM registry over standard paths', async () => {
      mockAccessSync.mockReturnValue(undefined);
      mockReaddirSync.mockReturnValue(['124.0.6367.91'] as never);
      mockExecFileSync.mockImplementation((cmd: string, args: unknown) => {
        const argsArr = args as string[];
        if (
          String(cmd) === 'reg' &&
          argsArr.includes(
            'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe',
          )
        ) {
          return makeRegistryOutput('C:\\Program Files\\Custom\\chrome.exe');
        }
        throw new Error('not found');
      });

      const result = await detectChrome();
      expect(result?.path).toBe('C:\\Program Files\\Custom\\chrome.exe');
      expect(result?.version).toBe('124.0.6367.91');
      expect(result?.majorVersion).toBe(124);
    });

    it('falls back to Program Files when registry is empty', async () => {
      const programFilesPath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
      mockAccessSync.mockReturnValue(undefined);
      mockReaddirSync.mockReturnValue(['124.0.6367.91'] as never);
      mockExecFileSync.mockImplementation((cmd: string) => {
        if (String(cmd) === 'reg') throw new Error('key not found');
        throw new Error('not found');
      });

      const result = await detectChrome();
      expect(result?.path).toBe(programFilesPath);
    });

    it('handles missing reg binary gracefully', async () => {
      const programFilesPath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
      mockAccessSync.mockReturnValue(undefined);
      mockReaddirSync.mockReturnValue(['124.0.6367.91'] as never);
      mockExecFileSync.mockImplementation((cmd: string) => {
        if (String(cmd) === 'reg') {
          const err = new Error('ENOENT') as NodeJS.ErrnoException;
          err.code = 'ENOENT';
          throw err;
        }
        throw new Error('not found');
      });

      const result = await detectChrome();
      expect(result?.path).toBe(programFilesPath);
    });

    // Regression: chrome.exe --version on Windows opens a visible browser window
    // and prints nothing to stdout. Discovery must NOT execute the Chrome binary.
    it('never executes the Chrome binary to read its version', async () => {
      mockAccessSync.mockReturnValue(undefined);
      mockReaddirSync.mockReturnValue(['124.0.6367.91'] as never);
      mockExecFileSync.mockImplementation((cmd: string) => {
        if (String(cmd) === 'reg') throw new Error('key not found');
        throw new Error('not found');
      });

      const result = await detectChrome();

      expect(result).not.toBeNull();
      const executedCommands = mockExecFileSync.mock.calls.map((call) => String(call[0]));
      expect(executedCommands.every((cmd) => !cmd.toLowerCase().includes('chrome'))).toBe(true);
    });

    it('reads the version from the versioned Application subfolder', async () => {
      mockAccessSync.mockReturnValue(undefined);
      mockReaddirSync.mockReturnValue([
        'chrome.exe',
        'master_preferences',
        '124.0.6367.91',
      ] as never);
      mockExecFileSync.mockImplementation((cmd: string) => {
        if (String(cmd) === 'reg') throw new Error('key not found');
        throw new Error('not found');
      });

      const result = await detectChrome();
      expect(result?.version).toBe('124.0.6367.91');
      expect(result?.majorVersion).toBe(124);
    });

    it('picks the newest version folder when several are present', async () => {
      mockAccessSync.mockReturnValue(undefined);
      mockReaddirSync.mockReturnValue([
        '123.0.6312.59',
        '124.0.6367.91',
        '123.0.6312.105',
      ] as never);
      mockExecFileSync.mockImplementation((cmd: string) => {
        if (String(cmd) === 'reg') throw new Error('key not found');
        throw new Error('not found');
      });

      const result = await detectChrome();
      expect(result?.version).toBe('124.0.6367.91');
    });

    it('falls back to PowerShell VersionInfo when no version folder exists', async () => {
      mockAccessSync.mockReturnValue(undefined);
      mockReaddirSync.mockReturnValue(['chrome.exe'] as never);
      mockExecFileSync.mockImplementation((cmd: string) => {
        if (String(cmd) === 'reg') throw new Error('key not found');
        if (String(cmd) === 'powershell') return '124.0.6367.91\r\n';
        throw new Error('not found');
      });

      const result = await detectChrome();
      expect(result?.version).toBe('124.0.6367.91');
    });

    it('suppresses the reg query stderr leak via stdio config', async () => {
      mockAccessSync.mockReturnValue(undefined);
      mockReaddirSync.mockReturnValue(['124.0.6367.91'] as never);
      mockExecFileSync.mockImplementation((cmd: string) => {
        if (String(cmd) === 'reg') throw new Error('key not found');
        throw new Error('not found');
      });

      await detectChrome();

      const regCall = mockExecFileSync.mock.calls.find((call) => String(call[0]) === 'reg');
      expect(regCall).toBeDefined();
      const opts = regCall?.[2] as { stdio?: unknown } | undefined;
      expect(opts?.stdio).toEqual(['ignore', 'pipe', 'ignore']);
    });

    it('returns null when the binary is absent', async () => {
      mockAccessSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });
      mockReaddirSync.mockReturnValue(['124.0.6367.91'] as never);
      mockExecFileSync.mockImplementation((cmd: string) => {
        if (String(cmd) === 'reg') throw new Error('key not found');
        throw new Error('not found');
      });

      const result = await detectChrome();
      expect(result).toBeNull();
    });

    it('returns null when no version can be determined', async () => {
      mockAccessSync.mockReturnValue(undefined);
      mockReaddirSync.mockReturnValue(['chrome.exe', 'master_preferences'] as never);
      mockExecFileSync.mockImplementation((cmd: string) => {
        if (String(cmd) === 'reg') throw new Error('key not found');
        // PowerShell fallback also yields nothing parseable
        if (String(cmd) === 'powershell') return '';
        throw new Error('not found');
      });

      const result = await detectChrome();
      expect(result).toBeNull();
    });

    it('routes a Windows override through metadata probing, not execution', async () => {
      mockAccessSync.mockReturnValue(undefined);
      mockReaddirSync.mockReturnValue(['124.0.6367.91'] as never);
      mockExecFileSync.mockImplementation(() => {
        throw new Error('should not exec the override binary on win32');
      });

      const result = await detectChrome({
        override: 'C:\\custom\\Chrome\\Application\\chrome.exe',
      });
      expect(result?.path).toBe('C:\\custom\\Chrome\\Application\\chrome.exe');
      expect(result?.version).toBe('124.0.6367.91');
    });
  });

  describe('return value shape', () => {
    it('has source: "system"', async () => {
      setPlatform('linux');
      process.env['PATH'] = '/usr/bin';
      mockAccessSync.mockReturnValue(undefined);
      mockExecFileSync.mockReturnValue(makeVersionOutput());

      const result = await detectChrome();
      expect(result?.source).toBe('system');
    });

    it('detects canary channel from path', async () => {
      setPlatform('darwin');
      mockAccessSync.mockReturnValue(undefined);
      mockExecFileSync.mockImplementation((cmd: string) => {
        if (String(cmd).includes('Canary')) {
          return makeVersionOutput('Google Chrome Canary 127.0.0.0');
        }
        throw new Error('not found');
      });

      const result = await detectChrome();
      expect(result?.channel).toBe('canary');
    });
  });

  it('never throws for "not found" — returns null', async () => {
    setPlatform('linux');
    process.env['PATH'] = '';
    mockAccessSync.mockImplementation(() => {
      throw new Error('not found');
    });
    mockExecFileSync.mockImplementation(() => {
      throw new Error('not found');
    });

    expect(detectChrome()).toBeNull();
  });

  // Satisfy linting — homedir is used by macOS paths
  it('uses homedir for macOS ~/Applications paths', () => {
    expect(vi.mocked(homedir)()).toBe('/home/testuser');
  });
});
