import { launchPerUsePageSource, type PageSource } from '../../../src/browser/page-source.js';
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

/** What the transport did to its pages, across every page the fake handed out. */
interface PageRecord {
  readonly visited: string[];
  readonly submissions: { readonly field: string; readonly query: string }[];
}

class FakePage implements Page {
  public constructor(
    private readonly html: string,
    private readonly formAction: string | null | undefined,
    private readonly record: PageRecord,
  ) {}
  public async goto(url: string): Promise<unknown> {
    this.record.visited.push(url);
    return { ok: true };
  }
  public async waitForNavigation(): Promise<unknown> {
    return null;
  }
  public async evaluate<T, A>(_fn: (arg: A) => T, arg?: A): Promise<T> {
    // Told apart by argument, since the fake cannot run in-page source:
    // none reads the page (`outerHTML`, answered with the fixture), a field
    // name asks for the search form's target, and a `{ field, query }`
    // submits that form.
    if (typeof arg === 'string') {
      const action = this.formAction === undefined ? this.record.visited.at(-1) : this.formAction;
      return action as unknown as T;
    }
    if (arg !== undefined) {
      this.record.submissions.push(arg as unknown as PageRecord['submissions'][number]);
      return undefined as T;
    }
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
  public constructor(
    private readonly html: string,
    private readonly formAction: string | null | undefined,
    private readonly record: PageRecord,
  ) {}
  public async newPage(): Promise<Page> {
    return new FakePage(this.html, this.formAction, this.record);
  }
  public async newIsolatedPage(): Promise<Page> {
    return new FakePage(this.html, this.formAction, this.record);
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
  /** One launch per use over {@link provider}, as the deterministic paths wire it. */
  readonly pages: PageSource;
  /** Number of times `launch` was called. */
  launches(): number;
  /** The `extraArgs` passed to the most recent launch. */
  lastExtraArgs(): readonly string[];
  /** The headless mode requested by the transport. */
  lastHeadless(): boolean | undefined;
  /** Every URL a page was sent to with `goto`, in order. */
  visited(): readonly string[];
  /** Every search-form submission, in order. */
  submissions(): readonly { readonly field: string; readonly query: string }[];
}

export interface FakeBrowserProviderOptions {
  /**
   * Where the page's search form submits; `null` means the page has no such
   * form. Defaults to the page's own URL, as a form posting back to itself.
   */
  readonly formAction?: string | null;
}

/**
 * A BrowserProvider double whose single page returns the given HTML string as
 * its SERP content. Records launch count and the transport-owned launch options;
 * core launcher compatibility is covered by browser launcher tests.
 */
export function fakeBrowserProvider(
  html: string,
  options: FakeBrowserProviderOptions = {},
): FakeBrowserProviderHandle {
  let launchCount = 0;
  let lastArgs: readonly string[] = [];
  let lastHeadless: boolean | undefined;
  const record: PageRecord = { visited: [], submissions: [] };

  const provider: BrowserProvider = {
    launch: async (launchOpts) => {
      launchCount += 1;
      lastArgs = launchOpts.extraArgs ?? [];
      lastHeadless = launchOpts.headless;
      return new FakeSession(html, options.formAction, record);
    },
    detectChrome: async () => CHROME_130,
  };

  return {
    provider,
    pages: launchPerUsePageSource(provider),
    launches: () => launchCount,
    lastExtraArgs: () => lastArgs,
    lastHeadless: () => lastHeadless,
    visited: () => record.visited,
    submissions: () => record.submissions,
  };
}
