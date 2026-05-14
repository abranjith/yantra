import { describe, expect, it, vi } from 'vitest';

import { BrowserLaunchError } from '../../src/browser/errors.js';
import { buildLaunchArgs } from '../../src/browser/launcher.js';
import { DEFAULT_STARTUP_TIMEOUT_MS, DEFAULT_VIEWPORT, parseLaunchOptions } from '../../src/browser/launch-options.js';
import type { ChromeInstall, ResolvedProfile } from '../../src/browser/types.js';

// We snapshot the args list produced by buildLaunchArgs.
// launchChrome itself is tested via integration tests (TASK-008).

const stubChrome: ChromeInstall = {
  path: '/usr/bin/google-chrome',
  version: '124.0.6367.91',
  majorVersion: 124,
  channel: 'stable',
  source: 'system',
};

const ephemeralProfile: ResolvedProfile = {
  absolutePath: '/tmp/yantra-test-uuid',
  kind: 'ephemeral',
  createdNow: true,
};

function makeOpts(overrides: Record<string, unknown> = {}) {
  return parseLaunchOptions({ profile: { kind: 'ephemeral' }, ...overrides });
}

describe('@no-llm launcher buildLaunchArgs', () => {
  it('snapshot: default headless args', () => {
    const opts = makeOpts();
    const args = buildLaunchArgs(opts);
    expect(args).toMatchSnapshot();
  });

  it('always includes hardened base args', () => {
    const args = buildLaunchArgs(makeOpts());
    expect(args).toContain('--no-first-run');
    expect(args).toContain('--no-default-browser-check');
    expect(args).toContain('--disable-sync');
  });

  it('never includes --remote-debugging-port', () => {
    const args = buildLaunchArgs(makeOpts());
    const hasPort = args.some((a) => a.startsWith('--remote-debugging-port'));
    expect(hasPort).toBe(false);
  });

  it('never includes --user-data-dir (handled by userDataDir option)', () => {
    const args = buildLaunchArgs(makeOpts());
    const hasDataDir = args.some((a) => a.startsWith('--user-data-dir'));
    expect(hasDataDir).toBe(false);
  });

  it('adds --window-size when viewport specified', () => {
    const args = buildLaunchArgs(makeOpts({ viewport: { width: 1920, height: 1080 } }));
    expect(args).toContain('--window-size=1920,1080');
  });

  it('omits --window-size when viewport is null', () => {
    const args = buildLaunchArgs(makeOpts({ viewport: null }));
    const hasWindowSize = args.some((a) => a.startsWith('--window-size'));
    expect(hasWindowSize).toBe(false);
  });

  it('appends extraArgs after base args', () => {
    const args = buildLaunchArgs(makeOpts({ extraArgs: ['--disable-gpu'] }));
    expect(args).toContain('--disable-gpu');
    // extraArgs come after the hardened base
    const baseEnd = args.indexOf('--disable-sync');
    const extraIdx = args.indexOf('--disable-gpu');
    expect(extraIdx).toBeGreaterThan(baseEnd);
  });

  it('default viewport args snapshot', () => {
    const opts = makeOpts({ viewport: DEFAULT_VIEWPORT });
    const args = buildLaunchArgs(opts);
    expect(args).toContain(`--window-size=${DEFAULT_VIEWPORT.width},${DEFAULT_VIEWPORT.height}`);
  });

  // Satisfy linting — references
  it('uses stub chrome and profile types', () => {
    expect(stubChrome.source).toBe('system');
    expect(ephemeralProfile.kind).toBe('ephemeral');
    expect(DEFAULT_STARTUP_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

describe('@no-llm BrowserLaunchError', () => {
  it('carries phase and lastStderr context', () => {
    const err = new BrowserLaunchError({ phase: 'timeout', lastStderr: 'stderr text', args: [] });
    expect(err.context.phase).toBe('timeout');
    expect(err.context.lastStderr).toBe('stderr text');
    expect(err.name).toBe('BrowserLaunchError');
  });
});


