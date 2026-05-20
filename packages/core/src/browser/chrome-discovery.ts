import { execFileSync } from 'node:child_process';
import { accessSync, constants, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import type { ChromeInstall } from './types.js';

const VERSION_PATTERN = /(\d+\.\d+\.\d+\.\d+|\d+\.\d+\.\d+)/;

/**
 * Stdio config that captures stdout but discards the child's stderr.
 * Without this, Node's execFileSync leaves stderr attached to the parent
 * console, so non-fatal child errors (e.g. `reg`'s "key not found") leak to
 * the user even when we swallow the thrown exception.
 */
const STDIO_CAPTURE_STDOUT: readonly ['ignore', 'pipe', 'ignore'] = ['ignore', 'pipe', 'ignore'];

/** Minimum version sanity check for the override path — returns null on parse failure. */
function tryParseVersion(stdout: string): {
  version: string;
  majorVersion: number;
  channel: ChromeInstall['channel'];
} | null {
  const trimmed = stdout.trim();
  const match = VERSION_PATTERN.exec(trimmed);
  if (!match?.[1]) return null;
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

/**
 * Compare two dotted version strings, newest first.
 * Used to pick the active version folder when several are present.
 */
function compareVersionDesc(a: string, b: string): number {
  const pa = a.split('.').map((p) => parseInt(p, 10));
  const pb = b.split('.').map((p) => parseInt(p, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Read Chrome's version from the versioned subfolder beside chrome.exe.
 *
 * Chrome on Windows installs each build into `<Application>\<version>\`
 * (e.g. `...\Application\124.0.6367.91\`). Reading that folder name is how we
 * obtain the version WITHOUT executing chrome.exe — running `chrome.exe
 * --version` on Windows prints nothing to stdout and instead opens a visible
 * browser window, which both fails detection and surprises the user.
 */
function readVersionFromAppDir(execPath: string): string | null {
  try {
    const appDir = dirname(execPath);
    const versions = readdirSync(appDir)
      .filter((name) => /^\d+\.\d+\.\d+\.\d+$/.test(name))
      .sort(compareVersionDesc);
    return versions[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Fallback: read the binary's product version via PowerShell's VersionInfo.
 * Still does not launch the browser. Used when the version subfolder is
 * absent (e.g. portable or non-standard installs).
 */
function readVersionFromPowerShell(execPath: string): string | null {
  try {
    const escaped = execPath.replace(/'/g, "''");
    const stdout = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-Item -LiteralPath '${escaped}').VersionInfo.ProductVersion`,
      ],
      {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
        stdio: [...STDIO_CAPTURE_STDOUT],
      },
    );
    return VERSION_PATTERN.exec(stdout.trim())?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Probe a Windows Chrome binary without executing it.
 * Returns null if the file is missing or no version can be determined.
 */
function probeWindowsChrome(
  execPath: string,
  channelHint: ChromeInstall['channel'] = 'unknown',
): ChromeInstall | null {
  if (!isExecutable(execPath)) return null;

  const version = readVersionFromAppDir(execPath) ?? readVersionFromPowerShell(execPath);
  if (!version) return null;

  const majorStr = version.split('.')[0];
  const majorVersion = majorStr !== undefined ? parseInt(majorStr, 10) : NaN;
  if (Number.isNaN(majorVersion)) return null;

  return {
    path: execPath,
    version,
    majorVersion,
    channel: channelHint,
    source: 'system',
  };
}

/**
 * Platform-aware probe. On Windows we read version metadata instead of
 * executing `<chrome> --version` (which opens a browser window there).
 */
function probeChrome(
  execPath: string,
  channelHint: ChromeInstall['channel'] = 'unknown',
): ChromeInstall | null {
  if (process.platform === 'win32') {
    return probeWindowsChrome(execPath, channelHint);
  }
  return probeVersion(execPath, channelHint);
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
  const PATH = process.env.PATH ?? '';
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
  const candidates: { path: string; channel: ChromeInstall['channel'] }[] = [
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
  const pathBinaries = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];
  for (const bin of pathBinaries) {
    const found = whichSync(bin);
    if (found) {
      const result = probeVersion(found);
      if (result) return result;
    }
  }

  const standardPaths: { path: string; channel: ChromeInstall['channel'] }[] = [
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
        // Discard stderr so `reg`'s "key not found" message does not leak to
        // the user's console when the key is absent (the common case).
        stdio: [...STDIO_CAPTURE_STDOUT],
      });
      const match = /REG_SZ\s+(.+)/.exec(output);
      if (match?.[1]) {
        const path = match[1].trim();
        const result = probeWindowsChrome(path, 'stable');
        if (result) return result;
      }
    } catch {
      // Registry key not found or reg binary unavailable — continue
    }
  }

  // Fallback standard paths
  const localAppData = process.env.LOCALAPPDATA ?? '';
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';

  const standardPaths: { path: string; channel: ChromeInstall['channel'] }[] = [
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
    const result = probeWindowsChrome(path, channel);
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
export function detectChrome(opts?: { readonly override?: string }): ChromeInstall | null {
  if (opts?.override) {
    const result = probeChrome(opts.override);
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
