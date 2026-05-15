import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import * as chromeDiscovery from '../../src/browser/chrome-discovery.js';
import { ChromeNotFoundError, ChromeVersionUnsupportedError } from '../../src/browser/errors.js';
import { MIN_SUPPORTED_CHROME_MAJOR } from '../../src/browser/launch-options.js';
import * as launcher from '../../src/browser/launcher.js';
import { LocalBrowserProvider } from '../../src/browser/provider.js';
import type {
  ChromeInstall,
  Logger,
  ProfileStore,
  ResolvedProfile,
} from '../../src/browser/types.js';

vi.mock('../../src/browser/chrome-discovery.js', () => ({
  detectChrome: vi.fn(),
}));
vi.mock('../../src/browser/launcher.js', () => ({
  launchChrome: vi.fn(),
  buildLaunchArgs: vi.fn(() => []),
}));
vi.mock('../../src/browser/session.js', () => ({
  LocalBrowserSession: vi.fn().mockImplementation(() => ({
    id: 'test-session-id',
    chrome: {},
    profilePath: '/tmp/profile',
    newPage: vi.fn(),
    close: vi.fn(),
    on: vi.fn(),
  })),
}));

const mockDetectChrome = vi.mocked(chromeDiscovery.detectChrome);
const mockLaunchChrome = vi.mocked(launcher.launchChrome);

function makeProfileStore(): ProfileStore {
  return {
    resolve: vi.fn().mockResolvedValue({
      absolutePath: '/tmp/yantra-test',
      kind: 'ephemeral',
      createdNow: true,
    } satisfies ResolvedProfile),
    listWorkflowProfiles: vi.fn().mockResolvedValue([]),
    removeWorkflowProfile: vi.fn().mockResolvedValue(undefined),
    cleanupEphemeral: vi.fn().mockResolvedValue(undefined),
  };
}

function makeChrome(majorVersion = 124): ChromeInstall {
  return {
    path: '/usr/bin/google-chrome',
    version: `${majorVersion}.0.0.0`,
    majorVersion,
    channel: 'stable',
    source: 'system',
  };
}

function makeMockBrowser() {
  return {
    process: vi.fn().mockReturnValue({ pid: 1234, kill: vi.fn(), on: vi.fn() }),
    close: vi.fn().mockResolvedValue(undefined),
    newPage: vi.fn(),
    on: vi.fn(),
  };
}

describe('@no-llm LocalBrowserProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDetectChrome.mockResolvedValue(makeChrome(124));
    const mockBrowser = makeMockBrowser();
    mockLaunchChrome.mockResolvedValue({
      browser: mockBrowser as never,
      child: mockBrowser.process() as never,
    });
  });

  it('throws ChromeNotFoundError when Chrome is not found', async () => {
    mockDetectChrome.mockResolvedValue(null);
    const provider = new LocalBrowserProvider({ profileStore: makeProfileStore() });

    await expect(provider.launch({ profile: { kind: 'ephemeral' } })).rejects.toThrow(
      ChromeNotFoundError,
    );
  });

  it('throws ChromeVersionUnsupportedError when Chrome version is too old', async () => {
    mockDetectChrome.mockResolvedValue(makeChrome(MIN_SUPPORTED_CHROME_MAJOR - 1));
    const provider = new LocalBrowserProvider({ profileStore: makeProfileStore() });

    await expect(provider.launch({ profile: { kind: 'ephemeral' } })).rejects.toThrow(
      ChromeVersionUnsupportedError,
    );
  });

  it('throws ChromeVersionUnsupportedError with correct found/required context', async () => {
    const tooOld = MIN_SUPPORTED_CHROME_MAJOR - 5;
    mockDetectChrome.mockResolvedValue(makeChrome(tooOld));
    const provider = new LocalBrowserProvider({ profileStore: makeProfileStore() });

    await expect(provider.launch({ profile: { kind: 'ephemeral' } })).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ChromeVersionUnsupportedError &&
        e.context.found === tooOld &&
        e.context.required === MIN_SUPPORTED_CHROME_MAJOR,
    );
  });

  it('launches successfully with a supported Chrome version', async () => {
    mockDetectChrome.mockResolvedValue(makeChrome(124));
    const mockBrowser = makeMockBrowser();
    mockLaunchChrome.mockResolvedValue({
      browser: mockBrowser as never,
      child: mockBrowser.process() as never,
    });

    const provider = new LocalBrowserProvider({ profileStore: makeProfileStore() });
    const session = await provider.launch({ profile: { kind: 'ephemeral' } });

    expect(session).toBeDefined();
  });

  it('does not log full args at info level', async () => {
    const logs: { level: string; msg: string }[] = [];
    const testLogger: Logger = {
      info: (_, msg) => logs.push({ level: 'info', msg: msg ?? '' }),
      warn: (_, msg) => logs.push({ level: 'warn', msg: msg ?? '' }),
      error: (_, msg) => logs.push({ level: 'error', msg: msg ?? '' }),
      debug: (_, msg) => logs.push({ level: 'debug', msg: msg ?? '' }),
    };

    mockDetectChrome.mockResolvedValue(makeChrome(124));
    const mockBrowser = makeMockBrowser();
    mockLaunchChrome.mockResolvedValue({
      browser: mockBrowser as never,
      child: mockBrowser.process() as never,
    });

    const provider = new LocalBrowserProvider({
      profileStore: makeProfileStore(),
      logger: testLogger,
    });
    await provider.launch({ profile: { kind: 'ephemeral' } });

    const infoLogs = logs.filter((l) => l.level === 'info');
    expect(infoLogs.length).toBeGreaterThan(0);
    // No info log should contain raw args with actual profile path
    for (const log of infoLogs) {
      expect(log.msg).not.toContain('--user-data-dir');
    }
  });

  it('uses chromeOverridePath when provided', async () => {
    mockDetectChrome.mockResolvedValue(makeChrome(124));
    const mockBrowser = makeMockBrowser();
    mockLaunchChrome.mockResolvedValue({
      browser: mockBrowser as never,
      child: mockBrowser.process() as never,
    });

    const provider = new LocalBrowserProvider({ profileStore: makeProfileStore() });
    await provider.launch({
      profile: { kind: 'ephemeral' },
      chromeOverridePath: '/custom/chrome',
    });

    // detectChrome should be called with the override
    expect(mockDetectChrome).toHaveBeenCalledWith({ override: '/custom/chrome' });
  });

  it('detectChrome delegates to chrome-discovery module', async () => {
    mockDetectChrome.mockResolvedValue(makeChrome(124));
    const provider = new LocalBrowserProvider({ profileStore: makeProfileStore() });
    const result = await provider.detectChrome();
    expect(result?.majorVersion).toBe(124);
  });

  it('rejects invalid options (bad schema) before touching Chrome', async () => {
    const provider = new LocalBrowserProvider({ profileStore: makeProfileStore() });

    await expect(
      provider.launch({ profile: { kind: 'workflow', workflowName: '' } }),
    ).rejects.toThrow();

    // detectChrome should not be called if options are invalid
    expect(mockDetectChrome).not.toHaveBeenCalled();
  });

  it('accepts options with no chromeOverridePath', async () => {
    mockDetectChrome.mockResolvedValue(makeChrome(124));
    const mockBrowser = makeMockBrowser();
    mockLaunchChrome.mockResolvedValue({
      browser: mockBrowser as never,
      child: mockBrowser.process() as never,
    });

    const provider = new LocalBrowserProvider({ profileStore: makeProfileStore() });
    // Should pass null override → detectChrome called with undefined override
    await provider.launch({ profile: { kind: 'ephemeral' }, chromeOverridePath: null });

    expect(mockDetectChrome as Mock).toHaveBeenCalledWith({ override: undefined });
  });
});
