import { describe, expect, it, vi } from 'vitest';

import type { AskEthicsDecision, AskEthicsGate } from '../../src/extraction/ethics-adapter.js';
import { FetchError, type ContentFetcher } from '../../src/extraction/fetcher.js';
import { ReadabilityExtractor, type Extractor } from '../../src/extraction/readability.js';
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
    expect(processed.cause).toBeInstanceOf(FetchError);
  });

  it('maps a browser-tier challenge to stage blocked and never extracts it (FEAT-050)', async () => {
    const extract = vi.fn(article.extract);
    const challenge = new FetchError('challenge', {
      url: HIT.url,
      kind: 'challenge',
      tier: 'browser',
      marker: 'data-sitekey',
    });

    const processed = await processSource(
      {
        ethicsGate: gate({ ok: true }),
        fetcher: { fetch: () => Promise.reject(challenge) },
        extractor: { extract },
      },
      HIT,
      OPTS,
    );

    expect(processed.doc).toBeNull();
    expect(processed.failure).toEqual({
      url: HIT.url,
      host: 'site.example',
      stage: 'blocked',
      reason: 'challenge page (data-sitekey)',
    });
    // The challenge was served by a real browser render.
    expect(processed.fetchMode).toBe('browser');
    expect(processed.cause).toBe(challenge);
    expect(extract).not.toHaveBeenCalled();
  });
});

describe('@no-llm extraction/source-processor shape-aware option (FEAT-051)', () => {
  /** Search-result cards with no prose: an article extractor finds nothing worth keeping. */
  const LISTING =
    '<html><body><ol>' +
    [1, 2, 3, 4]
      .map(
        (n) =>
          `<li><h3><a href="/item/${n}">Result item ${n}</a></h3><p><a href="/seller/${n}">Seller ${n}</a></p></li>`,
      )
      .join('') +
    '</ol></body></html>';

  function listingFetcher(): ContentFetcher {
    return { fetch: () => Promise.resolve({ ...doc('http'), html: LISTING }) };
  }

  it('without the option, a page with no article fails at extract exactly as before', async () => {
    const processed = await processSource(
      { ethicsGate: gate({ ok: true }), fetcher: listingFetcher(), extractor: empty },
      HIT,
      OPTS,
    );

    expect(processed.failure).toEqual({
      url: HIT.url,
      host: 'site.example',
      stage: 'extract',
      reason: 'could not extract a readable article',
    });
    expect(processed).not.toHaveProperty('page');
  });

  it('with the option, a page with page parts succeeds and carries the analysis', async () => {
    const extractor = new ReadabilityExtractor();
    const processed = await processSource(
      { ethicsGate: gate({ ok: true }), fetcher: listingFetcher(), extractor: empty },
      HIT,
      { ...OPTS, extractPage: (fetched) => extractor.extractPage(fetched) },
    );

    expect(processed.failure).toBeNull();
    expect(processed.page?.shape).toBe('collection');
    expect(processed.page?.records).toHaveLength(4);
    expect(processed.doc?.text).toBe(processed.page?.readableText);
  });

  it('with the option, a page with nothing at all still fails at extract', async () => {
    const processed = await processSource(
      {
        ethicsGate: gate({ ok: true }),
        fetcher: {
          fetch: () => Promise.resolve({ ...doc('http'), html: '<html><body></body></html>' }),
        },
        extractor: empty,
      },
      HIT,
      { ...OPTS, extractPage: (fetched) => new ReadabilityExtractor().extractPage(fetched) },
    );

    expect(processed.failure?.stage).toBe('extract');
    expect(processed.failure?.reason).toBe('could not extract readable content');
    expect(processed).not.toHaveProperty('page');
  });

  it('with the option, an article keeps its article fields', async () => {
    const processed = await processSource(
      {
        ethicsGate: gate({ ok: true }),
        fetcher: { fetch: () => Promise.resolve(doc('http')) },
        extractor: article,
      },
      HIT,
      {
        ...OPTS,
        extractPage: async (fetched) => ({
          article: await article.extract(fetched),
          page: {
            shape: 'article',
            records: [],
            structured: [],
            tables: [],
            fields: [],
            links: [],
            recordLinkCount: 0,
            readableText: 'body',
            coverage: { shape_basis: 'article: x', fetch_mode: 'http', not_found: [], omitted: [] },
          },
        }),
      },
    );

    expect(processed.doc).toMatchObject({ title: 'Page', text: 'body', excerpt: 'body' });
    expect(processed.page?.shape).toBe('article');
  });
});
