import { describe, expect, it } from 'vitest';

import type { ChromeInstall } from '../../src/browser/types.js';
import {
  buildDesktopChromeUserAgent,
  buildUserSimulationArgs,
} from '../../src/browser/user-simulation.js';

const chrome: ChromeInstall = {
  path: '/fake/chrome',
  version: '150.0.0.0',
  majorVersion: 150,
  channel: 'stable',
  source: 'system',
};

describe('@no-llm browser user simulation', () => {
  it.each([
    ['win32', 'Windows NT 10.0; Win64; x64'],
    ['darwin', 'Macintosh; Intel Mac OS X 10_15_7'],
    ['linux', 'X11; Linux x86_64'],
  ] as const)('builds a platform-consistent desktop UA on %s', (platform, token) => {
    const userAgent = buildDesktopChromeUserAgent(chrome.majorVersion, platform);

    expect(userAgent).toContain(token);
    expect(userAgent).toContain('Chrome/150.0.0.0');
    expect(userAgent).not.toContain('HeadlessChrome');
  });

  it('builds the bounded compatibility args from detected Chrome and host locale', () => {
    const args = buildUserSimulationArgs(chrome, { platform: 'linux', locale: 'fr-CA' });

    expect(args).toEqual([
      expect.stringContaining('X11; Linux x86_64') as string,
      '--disable-blink-features=AutomationControlled',
      '--lang=fr-CA',
    ]);
    expect(args[0]).toContain('Chrome/150.0.0.0');
    expect(args[0]).not.toContain('HeadlessChrome');
  });

  it('falls back safely when a supplied locale is malformed', () => {
    expect(buildUserSimulationArgs(chrome, { locale: 'en-US --no-sandbox' })).toContain(
      '--lang=en-US',
    );
  });
});
