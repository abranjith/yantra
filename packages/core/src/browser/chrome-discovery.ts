import { execFileSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { ChromeInstall } from './types.js';

/** Minimum version sanity check for the override path — returns null on parse failure. */
function tryParseVersion(stdout: string): {
  version: string;
  majorVersion: number;
  channel: ChromeInstall['channel'];
} | null {
  const trimmed = stdout.trim();
  const match = /(\d+\.\d+\.\d+\.\d+|\d+\.\d+\.\d+)/.exec(trimmed);
  if (!match || !match[1]) return null;
  const version = match[1];
  const majorStr = version.split('.')[0];
  const majorVersion = majorStr !== undefined ? parseInt(majorStr, 10) : 0;
  if (isNaN(majorVersion)) return null;

  const lower = trimmed.toLowerCase();
  let channel: ChromeInstall['channel'] = 'stable';
  if (lower.includes('canary')) channel = 'canary';
  else if (lower.includes('beta')) channel = 'beta';
  else if (lower.includes('dev')) channel = 'dev';
  else if (lower.includes('chromium')) channel = 'chromium';

  return { version, majorVersion, channel };
}

/**
 * Run `<path> --version` and parse the result.
 * Returns null if the binary isn't executable or version can't be parsed.
 */
function probeVersion(
  execPath: string,
  channelHint: ChromeInstall['channel'] = 'unknown',
): ChromeInstall | null {
  try {
    const stdout = execFileSync(execPath, ['--version'], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    });
    const parsed = tryParseVersion(stdout);
    if (!parsed) return null;
    return {
      path: execPath,
      version: parsed.version,
      majorVersion: parsed.majorVersion,
      channel: parsed.channel !== 'stable' ? parsed.channel : channelHint,
      source: 'system',
    };
  } catch {
    return null;
  }
}

/** Check if a file exists and is executable. */
function isExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Walk PATH for a binary name (POSIX). Returns absolute path or null. */
function whichSync(binary: string): string | null {
  const PATH = process.env['PATH'] ?? '';
  for (const dir of PATH.split(':')) {
    if (!dir) continue;
    const candidate = join(dir, binary);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

// ─── Platform-specific discovery ────────────────────────────────────────────

function discoverOnMacOS(): ChromeInstall | null {
  const home = homedir();
  const candidates: Array<{ path: string; channel: ChromeInstall['channel'] }> = [
    {
      path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      channel: 'stable',
    },
    {
      path: '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
      channel: 'beta',
    },
    {
      path: '/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev',
      channel: 'dev',
    },
    {
      path: '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      channel: 'canary',
    },
    {
      path: `${home}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
      channel: 'stable',
    },
    { path: '/Applications/Chromium.app/Contents/MacOS/Chromium', channel: 'chromium' },
  ];

  for (const { path, channel } of candidates) {
    const result = probeVersion(path, channel);
    if (result) return result;
  }

  // Fallback to PATH
  for (const bin of ['google-chrome', 'chromium']) {
    const found = whichSync(bin);
    if (found) {
      const result = probeVersion(found);
      if (result) return result;
    }
  }
  return null;
}

function discoverOnLinux(): ChromeInstall | null {
  // PATH-first, then standard paths
  const pathBinaries = [
    'google-chrome',
    'google-chrome-stable',
    'chromium',
    'chromium-browser',
  ];
  for (const bin of pathBinaries) {
    const found = whichSync(bin);
    if (found) {
      const result = probeVersion(found);
      if (result) return result;
    }
  }

  const standardPaths: Array<{ path: string; channel: ChromeInstall['channel'] }> = [
    { path: '/usr/bin/google-chrome', channel: 'stable' },
    { path: '/usr/bin/google-chrome-stable', channel: 'stable' },
    { path: '/usr/local/bin/google-chrome', channel: 'stable' },
    { path: '/snap/bin/chromium', channel: 'chromium' },
    { path: '/opt/google/chrome/chrome', channel: 'stable' },
    { path: '/usr/bin/chromium', channel: 'chromium' },
    { path: '/usr/bin/chromium-browser', channel: 'chromium' },
  ];

  for (const { path, channel } of standardPaths) {
    const result = probeVersion(path, channel);
    if (result) return result;
  }
  return null;
}

function discoverOnWindows(): ChromeInstall | null {
  // Try registry first
  const registryKeys = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe',
  ];
  for (const key of registryKeys) {
    try {
      const output = execFileSync('reg', ['query', key, '/ve'], {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
      });
      const match = /REG_SZ\s+(.+)/.exec(output);
      if (match?.[1]) {
        const path = match[1].trim();
        const result = probeVersion(path, 'stable');
        if (result) return result;
      }
    } catch {
      // Registry key not found or reg binary unavailable — continue
    }
  }

  // Fallback standard paths
  const localAppData = process.env['LOCALAPPDATA'] ?? '';
  const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';

  const standardPaths: Array<{ path: string; channel: ChromeInstall['channel'] }> = [
    {
      path: `${programFiles}\\Google\\Chrome\\Application\\chrome.exe`,
      channel: 'stable',
    },
    {
      path: `${programFilesX86}\\Google\\Chrome\\Application\\chrome.exe`,
      channel: 'stable',
    },
    {
      path: `${localAppData}\\Google\\Chrome\\Application\\chrome.exe`,
      channel: 'stable',
    },
    {
      path: `${localAppData}\\Google\\Chrome Beta\\Application\\chrome.exe`,
      channel: 'beta',
    },
    {
      path: `${localAppData}\\Google\\Chrome Canary\\Application\\chrome.exe`,
      channel: 'canary',
    },
  ];

  for (const { path, channel } of standardPaths) {
    const result = probeVersion(path, channel);
    if (result) return result;
  }
  return null;
}

/**
 * Detect the system Chrome installation.
 * Returns null if Chrome is not found — never throws for "not found".
 *
 * @param opts.override - Absolute path to a specific Chrome binary. Validated before use.
 * @example
 * const chrome = await detectChrome();
 * if (chrome) {
 *   console.log(`Found Chrome ${chrome.majorVersion} at ${chrome.path}`);
 * }
 */
export function detectChrome(opts?: {
  readonly override?: string;
}): ChromeInstall | null {
  if (opts?.override) {
    const result = probeVersion(opts.override);
    if (!result) return null;
    return result;
  }

  switch (process.platform) {
    case 'darwin':
      return discoverOnMacOS();
    case 'linux':
      return discoverOnLinux();
    case 'win32':
      return discoverOnWindows();
    default:
      return discoverOnLinux(); // best-effort on unknown platforms
  }
}
