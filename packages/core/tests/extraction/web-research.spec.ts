import { describe, expect, it, vi } from 'vitest';

import type { AskEthicsGate } from '../../src/extraction/ethics-adapter.js';
import { FetchError, type ContentFetcher } from '../../src/extraction/fetcher.js';
import type { Extractor } from '../../src/extraction/readability.js';
import type { SearchProvider } from '../../src/extraction/search/registry.js';
import type { ExtractedArticle, FetchedDoc, SearchResult } from '../../src/extraction/types.js';
import { webResearch, type WebResearchDeps } from '../../src/extraction/web-research.js';

function hit(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    url: 'https://example.com/1',
    title: 'A result',
    snippet: 'a snippet',
    source: 'duckduckgo',
    rank: 1,
    publishedAt: null,
    ...overrides,
  };
}

function fetchedDoc(url: string): FetchedDoc {
  return {
    url,
    finalUrl: url,
    fetchedAt: '2026-07-18T00:00:00.000Z',
    contentType: 'text/html',
    html: `<html><body><article>content for ${url}</article></body></html>`,
    statusCode: 200,
    fetchMode: 'http',
    elapsedMs: 5,
  };
}

function article(url: string): ExtractedArticle {
  return {
    url,
    title: `Title ${url}`,
    byline: null,
    publishedAt: null,
    siteName: null,
    contentText: `readable body for ${url}`,
    contentHtml: `<p>readable body for ${url}</p>`,
    excerpt: `excerpt for ${url}`,
    lengthChars: 20,
  };
}

/** A provider returning a fixed hit list. */
function providerReturning(hits: readonly SearchResult[]): SearchProvider {
  return { name: 'duckduckgo', search: () => Promise.resolve(hits) };
}

/** An ethics gate that allows every URL. */
function allowingEthics(): AskEthicsGate {
  return { checkUrl: () => Promise.resolve({ ok: true }) };
}

/** A fetcher whose behavior is keyed by URL. */
function fetcherByUrl(behavior: (url: string) => Promise<FetchedDoc>): ContentFetcher {
  return { fetch: (url) => behavior(url) };
}

/** An extractor whose behavior is keyed by the (final) URL. */
function extractorByUrl(behavior: (url: string) => ExtractedArticle | null): Extractor {
  return { extract: (doc) => Promise.resolve(behavior(doc.finalUrl)) };
}

function okDeps(hits: readonly SearchResult[]): WebResearchDeps {
  return {
    provider: providerReturning(hits),
    ethicsGate: allowingEthics(),
    fetcher: fetcherByUrl((url) => Promise.resolve(fetchedDoc(url))),
    extractor: extractorByUrl((url) => article(url)),
  };
}

const opts = {
  fetchTop: 3,
  resultCap: 8,
  perFetchTimeoutMs: 8_000,
  signal: new AbortController().signal,
};

describe('@no-llm webResearch', () => {
  it('fetches the top-N hits and returns the tail as remaining', async () => {
    const hits = Array.from({ length: 6 }, (_, i) =>
      hit({ url: `https://e.com/${i}`, rank: i + 1 }),
    );
    const { processed, remaining } = await webResearch(okDeps(hits), 'q', opts);

    expect(processed).toHaveLength(3);
    expect(processed.every((p) => p.doc !== null && p.failure === null)).toBe(true);
    expect(remaining).toHaveLength(3);
    expect(remaining.map((r) => r.url)).toEqual([
      'https://e.com/3',
      'https://e.com/4',
      'https://e.com/5',
    ]);
  });

  it('isolates a per-source failure (block, timeout, empty extract) without rejecting the batch', async () => {
    const hits = [
      hit({ url: 'https://blocked.com/', rank: 1 }),
      hit({ url: 'https://timeout.com/', rank: 2 }),
      hit({ url: 'https://empty.com/', rank: 3 }),
      hit({ url: 'https://ok.com/', rank: 4 }),
    ];
    const deps: WebResearchDeps = {
      provider: providerReturning(hits),
      ethicsGate: {
        checkUrl: (url) =>
          url.includes('blocked')
            ? Promise.resolve({ ok: false as const, reason: 'blocklist' as const, detail: 'nope' })
            : Promise.resolve({ ok: true as const }),
      },
      fetcher: fetcherByUrl((url) =>
        url.includes('timeout')
          ? Promise.reject(new FetchError('slow', { url, kind: 'timeout' }))
          : Promise.resolve(fetchedDoc(url)),
      ),
      extractor: extractorByUrl((url) => (url.includes('empty') ? null : article(url))),
    };

    const { processed } = await webResearch(deps, 'q', { ...opts, fetchTop: 4 });

    expect(processed).toHaveLength(4);
    expect(processed[0]?.failure?.stage).toBe('blocked');
    expect(processed[1]?.failure?.stage).toBe('fetch');
    expect(processed[2]?.failure?.stage).toBe('extract');
    expect(processed[3]?.doc).not.toBeNull();
  });

  it('cancels in-flight fetches when the signal aborts', async () => {
    const controller = new AbortController();
    const hits = [hit({ url: 'https://a.com/', rank: 1 })];
    const fetcher: ContentFetcher = {
      fetch: (_url, o) =>
        new Promise((_resolve, reject) => {
          const fail = (): void =>
            reject(new FetchError('aborted', { url: 'https://a.com/', kind: 'network' }));
          if (o.signal.aborted) {
            fail();
            return;
          }
          o.signal.addEventListener('abort', fail, { once: true });
        }),
    };
    const deps: WebResearchDeps = {
      provider: providerReturning(hits),
      ethicsGate: allowingEthics(),
      fetcher,
      extractor: extractorByUrl((url) => article(url)),
    };

    const promise = webResearch(deps, 'q', { ...opts, signal: controller.signal });
    controller.abort();
    const { processed } = await promise;

    expect(processed).toHaveLength(1);
    expect(processed[0]?.doc).toBeNull();
    expect(processed[0]?.failure?.stage).toBe('fetch');
  });

  it('fetches all hits and returns empty remaining when fetchTop exceeds the hit count', async () => {
    const hits = [hit({ url: 'https://a.com/', rank: 1 }), hit({ url: 'https://b.com/', rank: 2 })];
    const { processed, remaining } = await webResearch(okDeps(hits), 'q', { ...opts, fetchTop: 5 });

    expect(processed).toHaveLength(2);
    expect(remaining).toHaveLength(0);
  });

  it('preserves search-rank order across processed and remaining', async () => {
    const hits = Array.from({ length: 5 }, (_, i) =>
      hit({ url: `https://e.com/${i}`, rank: i + 1 }),
    );
    const { processed, remaining } = await webResearch(okDeps(hits), 'q', { ...opts, fetchTop: 2 });

    expect(processed.map((p) => p.doc?.url)).toEqual(['https://e.com/0', 'https://e.com/1']);
    expect(remaining.map((r) => r.url)).toEqual([
      'https://e.com/2',
      'https://e.com/3',
      'https://e.com/4',
    ]);
  });

  it('requests the provider with the configured resultCap and signal', async () => {
    const search = vi.fn(() => Promise.resolve([hit()]));
    const deps: WebResearchDeps = {
      provider: { name: 'duckduckgo', search },
      ethicsGate: allowingEthics(),
      fetcher: fetcherByUrl((url) => Promise.resolve(fetchedDoc(url))),
      extractor: extractorByUrl((url) => article(url)),
    };

    await webResearch(deps, 'my query', opts);

    expect(search).toHaveBeenCalledWith('my query', { limit: 8, signal: opts.signal });
  });
});
