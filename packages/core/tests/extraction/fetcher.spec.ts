import {
  Agent,
  MockAgent,
  getGlobalDispatcher,
  setGlobalDispatcher,
  type Dispatcher,
} from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PagePool } from '../../src/browser/page-pool.js';
import { launchPerUsePageSource } from '../../src/browser/page-source.js';
import type {
  BrowserProvider,
  BrowserSession,
  ChromeInstall,
  Page,
} from '../../src/browser/types.js';
import {
  BrowserFallbackFetcher,
  FetchError,
  HttpFetcher,
  HybridContentFetcher,
  type FetchTierEvent,
} from '../../src/extraction/fetcher.js';
import type { FetchedDoc } from '../../src/extraction/types.js';

class FakePage implements Page {
  public constructor(private readonly status: number | null = null) {}
  public async goto(): Promise<unknown> {
    // Puppeteer resolves `goto` with an HTTPResponse; a facade that cannot
    // report one (test fakes, same-document navigation) resolves with null.
    return this.status === null ? null : { status: () => this.status };
  }
  public async waitForNavigation(): Promise<unknown> {
    return null;
  }
  public async evaluate<T>(): Promise<T> {
    return '<html><main><article><p>rendered</p></article></main></html>' as T;
  }
  public async close(): Promise<void> {
    return;
  }
  public url(): string {
    return 'https://example.com/final';
  }
  public on(): void {
    return;
  }
}

class FakeSession implements BrowserSession {
  public constructor(
    private readonly status: number | null = null,
    private readonly onClose?: () => void,
  ) {}
  public readonly id = 's1';
  public readonly chrome: ChromeInstall = {
    path: '/fake/chrome',
    version: '124.0.0.0',
    majorVersion: 124,
    channel: 'stable',
    source: 'system',
  };
  public readonly profilePath = '/tmp/fake-profile';

  public async newPage(): Promise<Page> {
    return new FakePage(this.status);
  }
  public async newIsolatedPage(): Promise<Page> {
    return new FakePage(this.status);
  }
  public async close(): Promise<void> {
    this.onClose?.();
  }
  public on(): void {
    return;
  }
}

const fakeBrowserProvider: BrowserProvider = {
  launch: async () => new FakeSession(),
  detectChrome: async () => null,
};

/** A provider whose page reports `status` for every navigation. */
function providerWithStatus(status: number, onClose?: () => void): BrowserProvider {
  return {
    launch: async () => new FakeSession(status, onClose),
    detectChrome: async () => null,
  };
}

describe('@no-llm extraction/fetcher', () => {
  let mockAgent: MockAgent;
  let previousDispatcher: Dispatcher;

  beforeEach(() => {
    previousDispatcher = getGlobalDispatcher();
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
  });

  afterEach(async () => {
    setGlobalDispatcher(previousDispatcher ?? new Agent());
    await mockAgent.close();
  });

  it('fetches HTML over HTTP and returns metadata', async () => {
    mockAgent
      .get('https://example.com')
      .intercept({ path: '/ok', method: 'GET' })
      .reply(200, '<html><main><article>ok</article></main></html>', {
        headers: {
          'content-type': 'text/html; charset=utf-8',
        },
      });

    const fetcher = new HttpFetcher();
    const doc = await fetcher.fetch('https://example.com/ok', {
      timeoutMs: 8_000,
      signal: new AbortController().signal,
    });

    expect(doc.statusCode).toBe(200);
    expect(doc.fetchMode).toBe('http');
    expect(doc.contentType).toContain('text/html');
  });

  it('throws FetchError(kind=http-status) on non-success status', async () => {
    mockAgent
      .get('https://example.com')
      .intercept({ path: '/404', method: 'GET' })
      .reply(404, 'not found');

    const fetcher = new HttpFetcher();

    await expect(
      fetcher.fetch('https://example.com/404', {
        timeoutMs: 8_000,
        signal: new AbortController().signal,
      }),
    ).rejects.toSatisfy((error: unknown) => {
      return (
        error instanceof FetchError &&
        error.context.kind === 'http-status' &&
        error.context.statusCode === 404
      );
    });
  });

  it('throws FetchError(kind=too-large) when body exceeds max bytes', async () => {
    const payload = 'x'.repeat(1024);
    mockAgent
      .get('https://example.com')
      .intercept({ path: '/big', method: 'GET' })
      .reply(200, payload);

    const fetcher = new HttpFetcher({ maxBodyBytes: 128 });

    await expect(
      fetcher.fetch('https://example.com/big', {
        timeoutMs: 8_000,
        signal: new AbortController().signal,
      }),
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof FetchError && error.context.kind === 'too-large',
    );
  });

  it('escalates to browser fallback for js-heavy minimal HTML', async () => {
    mockAgent
      .get('https://example.com')
      .intercept({ path: '/spa', method: 'GET' })
      .reply(
        200,
        '<html><body><div id="root"></div><script src="/app.js"></script></body></html>',
        {
          headers: {
            'content-type': 'text/html',
          },
        },
      );

    const hybrid = new HybridContentFetcher({
      httpFetcher: new HttpFetcher(),
      browserFetcher: new BrowserFallbackFetcher({
        pages: launchPerUsePageSource(fakeBrowserProvider),
      }),
    });

    const doc = await hybrid.fetch('https://example.com/spa', {
      timeoutMs: 8_000,
      signal: new AbortController().signal,
    });

    expect(doc.fetchMode).toBe('browser');
    expect(doc.finalUrl).toBe('https://example.com/final');
  });

  it('rejects a browser navigation that landed on an HTTP error page', async () => {
    // Regression: Chrome renders "This page isn't working / HTTP ERROR 400" for
    // an error response, that interstitial extracts as readable prose, and the
    // hardcoded 200 published it as a Brief source excerpt.
    const fetcher = new BrowserFallbackFetcher({
      pages: launchPerUsePageSource(providerWithStatus(400)),
    });

    await expect(
      fetcher.fetch('https://example.com/ad-redirect', {
        timeoutMs: 8_000,
        signal: new AbortController().signal,
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof FetchError &&
        error.context.kind === 'http-status' &&
        error.context.statusCode === 400,
    );
  });

  it('closes the browser session when a navigation status is rejected', async () => {
    let closed = false;
    const fetcher = new BrowserFallbackFetcher({
      pages: launchPerUsePageSource(
        providerWithStatus(503, () => {
          closed = true;
        }),
      ),
    });

    await fetcher
      .fetch('https://example.com/down', {
        timeoutMs: 8_000,
        signal: new AbortController().signal,
      })
      .catch(() => undefined);

    expect(closed).toBe(true);
  });

  it('reports the real status for a successful browser navigation', async () => {
    const fetcher = new BrowserFallbackFetcher({
      pages: launchPerUsePageSource(providerWithStatus(204)),
    });

    const doc = await fetcher.fetch('https://example.com/ok', {
      timeoutMs: 8_000,
      signal: new AbortController().signal,
    });

    expect(doc.statusCode).toBe(204);
    expect(doc.fetchMode).toBe('browser');
  });

  it('keeps the 200 default when the page facade reports no response', async () => {
    const fetcher = new BrowserFallbackFetcher({
      pages: launchPerUsePageSource(fakeBrowserProvider),
    });

    const doc = await fetcher.fetch('https://example.com/spa', {
      timeoutMs: 8_000,
      signal: new AbortController().signal,
    });

    expect(doc.statusCode).toBe(200);
  });

  it('fails the hybrid fetch when both transports hit an error status', async () => {
    // The ad-redirect case end to end: HTTP 400, browser fallback 400, so the
    // caller records a per-source failure instead of an error-page "document".
    mockAgent
      .get('https://duckduckgo.example')
      .intercept({ path: '/y.js', method: 'GET' })
      .reply(400, '');

    const hybrid = new HybridContentFetcher({
      httpFetcher: new HttpFetcher(),
      browserFetcher: new BrowserFallbackFetcher({
        pages: launchPerUsePageSource(providerWithStatus(400)),
      }),
    });

    await expect(
      hybrid.fetch('https://duckduckgo.example/y.js', {
        timeoutMs: 8_000,
        signal: new AbortController().signal,
      }),
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof FetchError && error.context.kind === 'http-status',
    );
  });
});

describe('@no-llm extraction/fetcher browser fallback honors its deadline (FEAT-050)', () => {
  /** A provider whose page navigation never settles; records page closes. */
  function hangingProvider(): {
    readonly provider: BrowserProvider;
    readonly closes: () => number;
  } {
    let closes = 0;
    const page: Page = {
      goto: () => new Promise<unknown>(() => undefined),
      waitForNavigation: () => Promise.resolve(null),
      evaluate: <T>() => Promise.resolve('' as T),
      close: () => {
        closes += 1;
        return Promise.resolve();
      },
      url: () => 'https://example.com/hang',
      on: () => undefined,
    };
    const session: BrowserSession = {
      id: 'hang',
      chrome: {
        path: '/fake/chrome',
        version: '124.0.0.0',
        majorVersion: 124,
        channel: 'stable',
        source: 'system',
      },
      profilePath: '/tmp/fake',
      newPage: () => Promise.resolve(page),
      newIsolatedPage: () => Promise.resolve(page),
      close: () => Promise.resolve(),
      on: () => undefined,
    };
    return {
      provider: {
        launch: () => Promise.resolve(session),
        detectChrome: () => Promise.resolve(null),
      },
      closes: () => closes,
    };
  }

  it('rejects with a timeout FetchError within timeoutMs when goto never resolves', async () => {
    // Regression: the fallback took `_opts` and ignored it, waiting for
    // `networkidle2` for as long as the page took.
    const hanging = hangingProvider();
    const fetcher = new BrowserFallbackFetcher({ pages: launchPerUsePageSource(hanging.provider) });
    const started = Date.now();

    const error = await fetcher
      .fetch('https://example.com/hang', { timeoutMs: 50, signal: new AbortController().signal })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FetchError);
    expect((error as FetchError).context).toMatchObject({
      kind: 'timeout',
      url: 'https://example.com/hang',
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(hanging.closes()).toBeGreaterThanOrEqual(1);
  });

  it('rejects with the abort reason when the signal aborts mid-render', async () => {
    const hanging = hangingProvider();
    const pool = new PagePool({ provider: hanging.provider });
    const fetcher = new BrowserFallbackFetcher({ pages: pool });
    const controller = new AbortController();
    const reason = new Error('run aborted');

    const pending = fetcher.fetch('https://example.com/hang', {
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(reason), 10);

    await expect(pending).rejects.toBe(reason);
    expect(pool.stats().timeouts).toBe(0);
    await pool.close();
  });
});

describe('@no-llm extraction/fetcher hybrid classification (FEAT-050, policy b)', () => {
  const CHALLENGE =
    '<html><head><title>One moment</title></head><body><form action="/v">' +
    '<div data-sitekey="k"></div><button>Go</button></form></body></html>';
  const CONTENT =
    '<html><body><main><article><h1>Report</h1><p>Readable content.</p></article></main></body></html>';
  const SHELL =
    '<html><head><script src="/app.js"></script></head><body><div id="root"></div></body></html>';

  function tier(
    mode: 'http' | 'browser',
    html: string | Error,
  ): { readonly fetcher: { fetch: (url: string) => Promise<FetchedDoc> }; calls: () => number } {
    let calls = 0;
    return {
      calls: () => calls,
      fetcher: {
        fetch: (url) => {
          calls += 1;
          if (html instanceof Error) return Promise.reject(html);
          return Promise.resolve({
            url,
            finalUrl: url,
            fetchedAt: '2026-10-11T00:00:00.000Z',
            contentType: 'text/html',
            html,
            statusCode: 200,
            fetchMode: mode,
            elapsedMs: 1,
          });
        },
      },
    };
  }

  const OPTS = { timeoutMs: 1_000, signal: new AbortController().signal };

  function hybrid(http: string | Error, browser: string | Error) {
    const httpTier = tier('http', http);
    const browserTier = tier('browser', browser);
    const events: FetchTierEvent[] = [];
    const fetcher = new HybridContentFetcher({
      httpFetcher: httpTier.fetcher,
      browserFetcher: browserTier.fetcher,
      onTierEvent: (event) => events.push(event),
    });
    return { fetcher, events, renders: browserTier.calls };
  }

  it('renders an HTTP-tier challenge once and returns the browser content', async () => {
    const { fetcher, events, renders } = hybrid(CHALLENGE, CONTENT);

    const doc = await fetcher.fetch('https://site.example/list?page=2', OPTS);

    expect(doc.fetchMode).toBe('browser');
    expect(renders()).toBe(1);
    expect(events).toEqual([
      { kind: 'challenge', tier: 'http', marker: 'data-sitekey', host: 'site.example' },
      { kind: 'escalated', reason: 'http-challenge', host: 'site.example' },
    ]);
  });

  it('treats a browser-tier challenge as terminal after exactly one render', async () => {
    const { fetcher, events, renders } = hybrid(CHALLENGE, CHALLENGE);

    const error = await fetcher.fetch('https://site.example/list', OPTS).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FetchError);
    expect((error as FetchError).context).toMatchObject({
      kind: 'challenge',
      tier: 'browser',
      marker: 'data-sitekey',
    });
    expect(renders()).toBe(1);
    expect(
      events.map((event) => `${event.kind}/${'tier' in event ? event.tier : event.reason}`),
    ).toEqual(['challenge/http', 'escalated/http-challenge', 'challenge/browser']);
  });

  it('renders a js-shell once', async () => {
    const { fetcher, events, renders } = hybrid(SHELL, CONTENT);

    await fetcher.fetch('https://site.example/app', OPTS);

    expect(renders()).toBe(1);
    expect(events).toEqual([{ kind: 'escalated', reason: 'js-shell', host: 'site.example' }]);
  });

  it('returns HTTP content with no render and no events', async () => {
    const { fetcher, events, renders } = hybrid(CONTENT, CONTENT);

    const doc = await fetcher.fetch('https://site.example/a', OPTS);

    expect(doc.fetchMode).toBe('http');
    expect(renders()).toBe(0);
    expect(events).toEqual([]);
  });

  it('renders after an HTTP error, as before', async () => {
    const { fetcher, events, renders } = hybrid(
      new FetchError('HTTP 403', {
        url: 'https://site.example/a',
        kind: 'http-status',
        statusCode: 403,
      }),
      CONTENT,
    );

    await fetcher.fetch('https://site.example/a', OPTS);

    expect(renders()).toBe(1);
    expect(events).toEqual([{ kind: 'escalated', reason: 'http-error', host: 'site.example' }]);
  });

  it('returns a rendered js-shell as content rather than rendering twice', async () => {
    const { fetcher, renders } = hybrid(SHELL, SHELL);

    const doc = await fetcher.fetch('https://site.example/app', OPTS);

    expect(doc.html).toBe(SHELL);
    expect(renders()).toBe(1);
  });

  it('catches a challenge the old size heuristic missed: <main> and past 10 KB', async () => {
    const padded =
      '<html><head><title>Verification required</title></head><body><main>' +
      '<form action="/v"><h1>Please verify you are human</h1><div data-sitekey="k"></div></form>' +
      `${'<p>Help text that explains why the check is shown to visitors.</p>'.repeat(200)}` +
      '</main></body></html>';
    const { fetcher, events, renders } = hybrid(padded, padded);

    const error = await fetcher.fetch('https://site.example/x', OPTS).catch((e: unknown) => e);

    expect(padded.length).toBeGreaterThan(10_000);
    expect(error).toBeInstanceOf(FetchError);
    expect(renders()).toBe(1);
    expect(events[0]).toMatchObject({ kind: 'challenge', tier: 'http' });
  });
});
