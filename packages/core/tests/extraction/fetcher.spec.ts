import {
  Agent,
  MockAgent,
  getGlobalDispatcher,
  setGlobalDispatcher,
  type Dispatcher,
} from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
} from '../../src/extraction/fetcher.js';

class FakePage implements Page {
  public async goto(): Promise<unknown> {
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
    return new FakePage();
  }
  public async close(): Promise<void> {
    return;
  }
  public on(): void {
    return;
  }
}

const fakeBrowserProvider: BrowserProvider = {
  launch: async () => new FakeSession(),
  detectChrome: async () => null,
};

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
      browserFetcher: new BrowserFallbackFetcher({ browserProvider: fakeBrowserProvider }),
    });

    const doc = await hybrid.fetch('https://example.com/spa', {
      timeoutMs: 8_000,
      signal: new AbortController().signal,
    });

    expect(doc.fetchMode).toBe('browser');
    expect(doc.finalUrl).toBe('https://example.com/final');
  });
});
