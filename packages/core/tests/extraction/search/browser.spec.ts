import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { BrowserProvider, BrowserSession, ChromeInstall, Page } from '../../../src/browser/types.js';
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
  public async goto(_url: string): Promise<unknown> {
    return { ok: true };
  }

  public async evaluate<T>(_fn: () => T): Promise<T> {
    return parseFixtureRows() as unknown as T;
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
});
