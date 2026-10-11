import { describe, expect, it, vi } from 'vitest';

import type { AskEthicsDecision, AskEthicsGate } from '../../src/extraction/ethics-adapter.js';
import { FetchError, type ContentFetcher } from '../../src/extraction/fetcher.js';
import type { Extractor } from '../../src/extraction/readability.js';
import { processSource } from '../../src/extraction/source-processor.js';
import type { FetchedDoc, SearchResult } from '../../src/extraction/types.js';

const HIT: SearchResult = {
  url: 'https://site.example/page',
  title: 'Page',
  snippet: 'snippet',
  source: 'duckduckgo',
  rank: 3,
  publishedAt: null,
};

function gate(decision: AskEthicsDecision): AskEthicsGate {
  return { checkUrl: () => Promise.resolve(decision) };
}

function doc(fetchMode: 'http' | 'browser'): FetchedDoc {
  return {
    url: HIT.url,
    finalUrl: HIT.url,
    fetchedAt: '2026-10-10T00:00:00.000Z',
    contentType: 'text/html',
    html: '<article>body</article>',
    statusCode: 200,
    fetchMode,
    elapsedMs: 1,
  };
}

const article: Extractor = {
  extract: () =>
    Promise.resolve({
      url: HIT.url,
      title: 'Page',
      byline: null,
      publishedAt: null,
      siteName: null,
      contentText: 'body',
      contentHtml: '<p>body</p>',
      excerpt: 'body',
      lengthChars: 4,
    }),
};
const empty: Extractor = { extract: () => Promise.resolve(null) };

const OPTS = { perFetchTimeoutMs: 1000, signal: new AbortController().signal };

describe('@no-llm processSource — failure stages and fetch mode', () => {
  it('maps a budget refusal to stage budget without fetching', async () => {
    const fetcher: ContentFetcher = { fetch: vi.fn() };

    const processed = await processSource(
      {
        ethicsGate: gate({
          ok: false,
          reason: 'budget',
          limit: 'navigations',
          detail: 'Navigation budget of 30 navigations is exhausted.',
        }),
        fetcher,
        extractor: article,
      },
      HIT,
      OPTS,
    );

    expect(processed.failure?.stage).toBe('budget');
    expect(processed.failure?.host).toBe('site.example');
    expect(processed.fetchMode).toBeNull();
    expect(fetcher.fetch).not.toHaveBeenCalled();
  });

  it('maps a URL-policy refusal to stage policy without fetching', async () => {
    const fetcher: ContentFetcher = { fetch: vi.fn() };

    const processed = await processSource(
      {
        ethicsGate: gate({ ok: false, reason: 'policy', code: 'URL_TOO_LONG', detail: 'too long' }),
        fetcher,
        extractor: article,
      },
      HIT,
      OPTS,
    );

    expect(processed.failure?.stage).toBe('policy');
    expect(fetcher.fetch).not.toHaveBeenCalled();
  });

  it('keeps an ethics refusal as stage blocked', async () => {
    const processed = await processSource(
      {
        ethicsGate: gate({ ok: false, reason: 'robots', detail: 'Disallow: /' }),
        fetcher: { fetch: vi.fn() },
        extractor: article,
      },
      HIT,
      OPTS,
    );

    expect(processed.failure?.stage).toBe('blocked');
    expect(processed.failure?.reason).toBe('robots - Disallow: /');
  });

  it.each(['http', 'browser'] as const)('reports fetchMode %s on success', async (mode) => {
    const processed = await processSource(
      {
        ethicsGate: gate({ ok: true }),
        fetcher: { fetch: () => Promise.resolve(doc(mode)) },
        extractor: article,
      },
      HIT,
      OPTS,
    );

    expect(processed.doc?.title).toBe('Page');
    expect(processed.fetchMode).toBe(mode);
  });

  it('keeps the fetch mode when extraction fails after a real fetch', async () => {
    const processed = await processSource(
      {
        ethicsGate: gate({ ok: true }),
        fetcher: { fetch: () => Promise.resolve(doc('browser')) },
        extractor: empty,
      },
      HIT,
      OPTS,
    );

    expect(processed.failure?.stage).toBe('extract');
    expect(processed.fetchMode).toBe('browser');
  });

  it('reports a null fetch mode when the fetch itself failed', async () => {
    const onTimeout = vi.fn();
    const processed = await processSource(
      {
        ethicsGate: gate({ ok: true }),
        fetcher: {
          fetch: () => Promise.reject(new FetchError('slow', { url: HIT.url, kind: 'timeout' })),
        },
        extractor: article,
      },
      HIT,
      { ...OPTS, onTimeout },
    );

    expect(processed.failure?.stage).toBe('fetch');
    expect(processed.failure?.reason).toBe('fetch timed out');
    expect(processed.fetchMode).toBeNull();
    expect(onTimeout).toHaveBeenCalledOnce();
  });
});
