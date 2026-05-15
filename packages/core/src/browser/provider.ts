import { detectChrome } from './chrome-discovery.js';
import { ChromeNotFoundError, ChromeVersionUnsupportedError } from './errors.js';
import { MIN_SUPPORTED_CHROME_MAJOR, parseLaunchOptions } from './launch-options.js';
import { launchChrome } from './launcher.js';
import { LocalBrowserSession } from './session.js';
import type {
  BrowserProvider,
  BrowserSession,
  ChromeInstall,
  LaunchOptions,
  Logger,
  ProfileStore,
} from './types.js';

/* eslint-disable @typescript-eslint/no-empty-function */
const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};
/* eslint-enable @typescript-eslint/no-empty-function */

/**
 * Launches a local system Chrome instance over CDP pipe transport.
 * Strategy interface implementation for MVP — Phase 3+ adds RemoteBrowserProvider.
 *
 * @example
 * const provider = new LocalBrowserProvider({ profileStore: new LocalProfileStore() });
 * const session = await provider.launch({ profile: { kind: 'ephemeral' } });
 */
export class LocalBrowserProvider implements BrowserProvider {
  private readonly profileStore: ProfileStore;
  private readonly logger: Logger;
  private readonly clock: () => Date;

  constructor(deps: { profileStore: ProfileStore; logger?: Logger; clock?: () => Date }) {
    this.profileStore = deps.profileStore;
    this.logger = deps.logger ?? noopLogger;
    this.clock = deps.clock ?? (() => new Date());
  }

  /** @inheritdoc */
  detectChrome(): Promise<ChromeInstall | null> {
    return Promise.resolve(detectChrome());
  }

  /**
   * Launches Chrome and returns a live BrowserSession.
   *
   * Sequence:
   * 1. Validate options via Zod
   * 2. Resolve profile directory
   * 3. Discover Chrome (with optional override)
   * 4. Launch Chrome via CDP pipe
   * 5. Wrap in LocalBrowserSession
   *
   * @throws {BrowserLaunchError} on invalid options or launch failure
   * @throws {ChromeNotFoundError} when Chrome cannot be found
   * @throws {ChromeVersionUnsupportedError} when Chrome is too old
   */
  async launch(options: Partial<LaunchOptions>): Promise<BrowserSession> {
    const opts = parseLaunchOptions(options);

    const profile = await this.profileStore.resolve(opts.profile);

    const chrome = detectChrome({
      ...(typeof opts.chromeOverridePath === 'string' ? { override: opts.chromeOverridePath } : {}),
    });

    if (!chrome) {
      throw new ChromeNotFoundError({
        os: process.platform,
        probed: ['system paths — run `yantra doctor` for details'],
      });
    }

    if (chrome.majorVersion < MIN_SUPPORTED_CHROME_MAJOR) {
      throw new ChromeVersionUnsupportedError({
        found: chrome.majorVersion,
        required: MIN_SUPPORTED_CHROME_MAJOR,
      });
    }

    // info-level: version + path only — never log full args (profile path may be PII-bearing)
    this.logger.info(
      { chromeMajor: chrome.majorVersion },
      `launching Chrome ${chrome.version} from ${chrome.path}`,
    );

    const { browser, child } = await launchChrome(opts, chrome, profile);

    return new LocalBrowserSession({
      browser,
      child,
      chrome,
      profile,
      profileStore: this.profileStore,
      logger: this.logger,
    });
  }
}
