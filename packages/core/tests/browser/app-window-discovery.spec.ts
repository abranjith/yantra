// @no-llm
/**
 * Choosing the browser for the Yantra app window (FEAT-065 TASK-006, D10):
 * system Chrome (never Chrome for Testing), then Edge.
 */

import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  detectAppWindowBrowser,
  edgeCandidates,
  isChromeForTesting,
} from '../../src/browser/chrome-discovery.js';
import type { ChromeInstall } from '../../src/browser/types.js';

function chrome(overrides: Partial<ChromeInstall> = {}): ChromeInstall {
  return {
    path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    version: '131.0.0.0',
    majorVersion: 131,
    channel: 'stable',
    source: 'system',
    ...overrides,
  };
}

const WIN_ENV = {
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
};
const EDGE_X86 = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const EDGE_64 = 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe';

describe('detectAppWindowBrowser', () => {
  it('prefers system Google Chrome', () => {
    const found = detectAppWindowBrowser({
      platform: 'win32',
      env: WIN_ENV,
      detectChrome: () => chrome(),
      isExecutable: () => true,
    });
    expect(found).toEqual({ kind: 'chrome', path: chrome().path, name: 'Google Chrome' });
  });

  it.each(['beta', 'dev', 'canary'] as const)('accepts the Google Chrome %s channel', (channel) => {
    const found = detectAppWindowBrowser({
      platform: 'win32',
      env: WIN_ENV,
      detectChrome: () => chrome({ channel }),
      isExecutable: () => false,
    });
    expect(found?.kind).toBe('chrome');
  });

  it('falls back to Edge when there is no Chrome', () => {
    const found = detectAppWindowBrowser({
      platform: 'win32',
      env: WIN_ENV,
      detectChrome: () => null,
      isExecutable: (path) => path === EDGE_64,
    });
    expect(found).toEqual({ kind: 'edge', path: EDGE_64, name: 'Microsoft Edge' });
  });

  it.each([
    ['a managed build', chrome({ source: 'managed' })],
    ['a chrome-for-testing path', chrome({ path: '/opt/chrome-for-testing/chrome' })],
    ['a CfT zip layout', chrome({ path: 'C:\\x\\chrome-win64\\chrome.exe' })],
    ['plain Chromium', chrome({ channel: 'chromium', path: '/usr/bin/chromium' })],
  ])('never chooses %s while Edge exists', (_label, install) => {
    const found = detectAppWindowBrowser({
      platform: 'win32',
      env: WIN_ENV,
      detectChrome: () => install,
      isExecutable: (path) => path === EDGE_X86,
    });
    expect(found).toEqual({ kind: 'edge', path: EDGE_X86, name: 'Microsoft Edge' });
  });

  it('returns null when neither exists', () => {
    expect(
      detectAppWindowBrowser({
        platform: 'linux',
        env: { PATH: '/usr/bin:/bin' },
        detectChrome: () => null,
        isExecutable: () => false,
      }),
    ).toBeNull();
  });

  it('finds microsoft-edge-stable on the Linux PATH', () => {
    const target = join('/opt/bin', 'microsoft-edge-stable');
    const found = detectAppWindowBrowser({
      platform: 'linux',
      env: { PATH: '/usr/bin:/opt/bin' },
      detectChrome: () => null,
      isExecutable: (path) => path === target,
    });
    expect(found?.path).toBe(target);
  });
});

describe('edgeCandidates', () => {
  it('checks Program Files (x86) before Program Files on Windows', () => {
    expect(edgeCandidates('win32', WIN_ENV)).toEqual([EDGE_X86, EDGE_64]);
  });

  it('uses the standard bundle on macOS', () => {
    expect(edgeCandidates('darwin', {})).toEqual([
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ]);
  });

  it('tries both Linux names in every PATH directory', () => {
    expect(edgeCandidates('linux', { PATH: '/a:/b' })).toEqual([
      join('/a', 'microsoft-edge'),
      join('/b', 'microsoft-edge'),
      join('/a', 'microsoft-edge-stable'),
      join('/b', 'microsoft-edge-stable'),
    ]);
  });
});

describe('isChromeForTesting', () => {
  it('treats a system stable Chrome as not CfT', () => {
    expect(isChromeForTesting(chrome())).toBe(false);
  });
});
