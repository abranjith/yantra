import type {
  BrowserProvider,
  BrowserSession,
  ChromeInstall,
  Logger,
  Page,
} from '../../../src/browser/types.js';
import type { SearchEthicsGate } from '../../../src/extraction/search/scrape-transport.js';
import type { KeychainProvider } from '../../../src/secrets/keychain.js';

/** A no-op logger for tests. */
export const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

/** An ethics gate that always passes. */
export const passGate: SearchEthicsGate = {
  checkUrl: async () => ({ ok: true }),
};

/** An ethics gate that always refuses with the given reason/detail. */
export function refuseGate(reason: string, detail: string): SearchEthicsGate {
  return { checkUrl: async () => ({ ok: false, reason, detail }) };
}

/** Builds a keychain double backed by the given account→value map. */
export function keychainWith(entries: Record<string, string>): KeychainProvider {
  return {
    get: async (_service, account) => entries[account] ?? null,
    set: async () => undefined,
    delete: async () => false,
    list: async () => [],
    isAvailable: async () => true,
  };
}

const CHROME_130: ChromeInstall = {
  path: '/fake/chrome',
  version: '130.0.6700.0',
  majorVersion: 130,
  channel: 'stable',
  source: 'system',
};

class FakePage implements Page {
  public constructor(private readonly html: string) {}
  public async goto(): Promise<unknown> {
    return { ok: true };
  }
  public async evaluate<T>(): Promise<T> {
    // The scrape transport reads the SERP via
    // `page.evaluate(() => document.documentElement.outerHTML)`; the fake just
    // returns the fixture HTML regardless of the passed function.
    return this.html as unknown as T;
  }
  public async close(): Promise<void> {
    return;
  }
  public url(): string {
    return 'https://example.com/serp';
  }
  public on(): void {
    return;
  }
}

class FakeSession implements BrowserSession {
  public readonly id = 'fake-session';
  public readonly chrome = CHROME_130;
  public readonly profilePath = '/tmp/fake-profile';
  public constructor(private readonly html: string) {}
  public async newPage(): Promise<Page> {
    return new FakePage(this.html);
  }
  public async close(): Promise<void> {
    return;
  }
  public on(): void {
    return;
  }
}

export interface FakeBrowserProviderHandle {
  readonly provider: BrowserProvider;
  /** Number of times `launch` was called. */
  launches(): number;
  /** The `extraArgs` passed to the most recent launch. */
  lastExtraArgs(): readonly string[];
  /** The headless mode requested by the transport. */
  lastHeadless(): boolean | undefined;
}

/**
 * A BrowserProvider double whose single page returns the given HTML string as
 * its SERP content. Records launch count and the transport-owned launch options;
 * core launcher compatibility is covered by browser launcher tests.
 */
export function fakeBrowserProvider(html: string): FakeBrowserProviderHandle {
  let launchCount = 0;
  let lastArgs: readonly string[] = [];
  let lastHeadless: boolean | undefined;

  const provider: BrowserProvider = {
    launch: async (launchOpts) => {
      launchCount += 1;
      lastArgs = launchOpts.extraArgs ?? [];
      lastHeadless = launchOpts.headless;
      return new FakeSession(html);
    },
    detectChrome: async () => CHROME_130,
  };

  return {
    provider,
    launches: () => launchCount,
    lastExtraArgs: () => lastArgs,
    lastHeadless: () => lastHeadless,
  };
}
