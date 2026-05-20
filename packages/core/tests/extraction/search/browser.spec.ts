import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import type {
  BrowserProvider,
  BrowserSession,
  ChromeInstall,
  Page,
} from '../../../src/browser/types.js';
import { BrowserSearchProvider } from '../../../src/extraction/search/browser.js';

const fixtureHtml = readFileSync(
  resolve(import.meta.dirname, '../__fixtures__/ddg-html-result.html'),
  'utf8',
);

function parseFixtureRows(): { href: string; title: string; snippet: string | null }[] {
  const rows: { href: string; title: string; snippet: string | null }[] = [];
  const itemRegex = /<div class="result">([\s\S]*?)<\/div>/g;
  for (const match of fixtureHtml.matchAll(itemRegex)) {
    const block = match[1] ?? '';
    const href = /href="([^"]+)"/.exec(block)?.[1] ?? '';
    const title = /class="result__a"[^>]*>([^<]+)</.exec(block)?.[1]?.trim() ?? '';
    const snippet = /class="result__snippet"[^>]*>([^<]+)</.exec(block)?.[1]?.trim() ?? null;
    rows.push({ href, title, snippet });
  }
  return rows;
}

class FakePage implements Page {
  public constructor(private readonly blocked = false) {}

  public async goto(_url: string): Promise<unknown> {
    return { ok: true };
  }

  public async evaluate<T>(_fn: () => T): Promise<T> {
    return {
      rows: this.blocked ? [] : parseFixtureRows(),
      blocked: this.blocked,
    } as unknown as T;
  }

  public async close(): Promise<void> {
    return;
  }

  public url(): string {
    return 'https://html.duckduckgo.com/html/?q=ai+news';
  }

  public on(): void {
    return;
  }
}

class FakeSession implements BrowserSession {
  public readonly id = 'session-1';
  public readonly chrome: ChromeInstall = {
    path: '/fake/chrome',
    version: '124.0.0.0',
    majorVersion: 124,
    channel: 'stable',
    source: 'system',
  };
  public readonly profilePath = '/tmp/fake-profile';

  public constructor(private readonly blocked = false) {}

  public async newPage(): Promise<Page> {
    return new FakePage(this.blocked);
  }

  public async close(): Promise<void> {
    return;
  }

  public on(): void {
    return;
  }
}

describe('@no-llm extraction/search/browser', () => {
  it('extracts top results from browser-rendered html page', async () => {
    let launched = 0;
    const browserProvider: BrowserProvider = {
      launch: async () => {
        launched += 1;
        return new FakeSession();
      },
      detectChrome: async () => null,
    };

    const provider = new BrowserSearchProvider({
      browserProvider,
      ethicsGate: {
        checkUrl: async () => ({ ok: true }),
      },
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        debug: () => undefined,
      },
    });

    const rows = await provider.search('ai news', {
      limit: 3,
      signal: new AbortController().signal,
    });

    expect(launched).toBe(1);
    expect(rows).toHaveLength(3);
    expect(rows[0]?.title).toBe('First Result');
    expect(rows[2]?.url).toBe('https://example.com/three');
  });

  it('throws a clear anomaly error when DuckDuckGo serves an anti-bot challenge', async () => {
    const provider = new BrowserSearchProvider({
      browserProvider: {
        launch: async () => new FakeSession(true),
        detectChrome: async () => null,
      },
      ethicsGate: { checkUrl: async () => ({ ok: true }) },
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        debug: () => undefined,
      },
    });

    const error = await provider
      .search('ai news', { limit: 3, signal: new AbortController().signal })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    const msg = (error as Error).message;
    expect(msg).toContain('anti-bot challenge');
    expect(msg).not.toContain('did not return result rows');
    expect((error as { context?: { code?: string } }).context?.code).toBe('anomaly-challenge');
  });

  it('launches with a non-headless User-Agent and automation masking to avoid the bot wall', async () => {
    let launchOpts: { extraArgs?: readonly string[] } | undefined;
    const provider = new BrowserSearchProvider({
      browserProvider: {
        launch: async (opts) => {
          launchOpts = opts;
          return new FakeSession();
        },
        detectChrome: async () => ({
          path: '/fake/chrome',
          version: '130.0.6700.0',
          majorVersion: 130,
          channel: 'stable',
          source: 'system',
        }),
      },
      ethicsGate: { checkUrl: async () => ({ ok: true }) },
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        debug: () => undefined,
      },
    });

    await provider.search('ai news', { limit: 3, signal: new AbortController().signal });

    const args = launchOpts?.extraArgs ?? [];
    const uaArg = args.find((a) => a.startsWith('--user-agent='));
    expect(uaArg).toBeDefined();
    expect(uaArg).not.toContain('HeadlessChrome');
    // User-Agent reflects the detected Chrome major version.
    expect(uaArg).toContain('Chrome/130.0.0.0');
    expect(args).toContain('--disable-blink-features=AutomationControlled');
  });

  it('refuses before browser launch when ethics gate blocks search url', async () => {
    let launched = 0;
    const provider = new BrowserSearchProvider({
      browserProvider: {
        launch: async () => {
          launched += 1;
          return new FakeSession();
        },
        detectChrome: async () => null,
      },
      ethicsGate: {
        checkUrl: async () => ({ ok: false, reason: 'robots', detail: 'disallowed' }),
      },
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        debug: () => undefined,
      },
    });

    await expect(
      provider.search('ai news', {
        limit: 3,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow();

    expect(launched).toBe(0);
  });

  it('error message includes reason and detail when ethics gate refuses', async () => {
    const provider = new BrowserSearchProvider({
      browserProvider: {
        launch: async () => new FakeSession(),
        detectChrome: async () => null,
      },
      ethicsGate: {
        checkUrl: async () => ({
          ok: false,
          reason: 'robots' as const,
          detail: 'Disallowed by robots.txt at "html.duckduckgo.com"',
        }),
      },
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        debug: () => undefined,
      },
    });

    const error = await provider
      .search("today's top news", { limit: 3, signal: new AbortController().signal })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    const msg = (error as Error).message;
    expect(msg).toContain('robots');
    expect(msg).toContain('Disallowed by robots.txt at "html.duckduckgo.com"');
    expect(msg).toContain('html.duckduckgo.com');
  });

  it.each([
    ['robots', 'Disallowed by robots.txt at "example.com"'],
    ['blocklist', 'Host is in the ads blocklist'],
    ['rate-limit', 'rate limit exceeded'],
  ] as const)('error message surfaces reason=%s for ethics refusal', async (reason, detail) => {
    const provider = new BrowserSearchProvider({
      browserProvider: {
        launch: async () => new FakeSession(),
        detectChrome: async () => null,
      },
      ethicsGate: {
        checkUrl: async () => ({ ok: false, reason, detail }),
      },
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        debug: () => undefined,
      },
    });

    const error = await provider
      .search('test query', { limit: 1, signal: new AbortController().signal })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    const msg = (error as Error).message;
    expect(msg).toContain(reason);
    expect(msg).toContain(detail);
  });
});
