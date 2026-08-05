import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DuckDuckGoSearchProvider } from '../../../src/extraction/search/duckduckgo.js';
import { ScrapeSearchError } from '../../../src/extraction/search/errors.js';
import { ScrapeTransport } from '../../../src/extraction/search/scrape-transport.js';

import { fakeBrowserProvider, passGate, refuseGate, silentLogger } from './helpers.js';

function fixture(name: string): string {
  return readFileSync(resolve(import.meta.dirname, 'fixtures', name), 'utf8');
}

function providerFor(html: string, gate = passGate): DuckDuckGoSearchProvider {
  const transport = new ScrapeTransport({
    browserProvider: fakeBrowserProvider(html).provider,
    ethicsGate: gate,
    logger: silentLogger,
  });
  return new DuckDuckGoSearchProvider({ transport });
}

describe('@no-llm extraction/search/duckduckgo', () => {
  it('parses organic result rows from the SERP fixture', async () => {
    const provider = providerFor(fixture('duckduckgo-serp.html'));

    const rows = await provider.search('ai news', {
      limit: 3,
      signal: new AbortController().signal,
    });

    expect(rows).toHaveLength(3);
    expect(rows[0]?.title).toBe('First Result');
    expect(rows[0]?.snippet).toBe('First snippet text');
    expect(rows[0]?.source).toBe('duckduckgo');
    expect(rows.map((r) => r.rank)).toEqual([0, 1, 2]);
  });

  it('canonicalizes DuckDuckGo redirect (/l/?uddg=) hrefs to the target url', async () => {
    const provider = providerFor(fixture('duckduckgo-serp.html'));

    const rows = await provider.search('ai news', {
      limit: 3,
      signal: new AbortController().signal,
    });

    expect(rows[2]?.url).toBe('https://example.com/three');
  });

  it('drops sponsored rows so an ad tracker never outranks an organic hit', async () => {
    // Regression: run 20260804T043011Z-do-b85f02f1 published two
    // `duckduckgo.com/y.js?ad_domain=…` ad-click trackers as its Brief sources.
    // They sit above the organic rows, so unfiltered they take rank 0.
    const provider = providerFor(fixture('duckduckgo-serp.html'));

    const rows = await provider.search('cheap hotels', {
      limit: 5,
      signal: new AbortController().signal,
    });

    expect(rows.map((r) => r.url)).toEqual([
      'https://example.com/one',
      'https://example.com/two',
      'https://example.com/three',
    ]);
    expect(rows.some((r) => r.url.includes('/y.js'))).toBe(false);
    expect(rows.some((r) => r.title === 'Sponsored Result')).toBe(false);
  });

  it('drops an ad href even when the row carries no ad class', async () => {
    const provider = providerFor(
      '<html><body><div class="serp__results">' +
        '<div class="result"><a class="result__a" href="//duckduckgo.com/y.js?ad_domain=x">Ad</a></div>' +
        '<div class="result"><a class="result__a" href="https://example.com/real">Real</a></div>' +
        '</div></body></html>',
    );

    const rows = await provider.search('ai news', {
      limit: 3,
      signal: new AbortController().signal,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.url).toBe('https://example.com/real');
  });

  it('reports empty-results for an all-sponsored page rather than returning ads', async () => {
    const provider = providerFor(
      '<html><body><div class="serp__results">' +
        '<div class="result result--ad"><a class="result__a" href="//duckduckgo.com/y.js?ad_domain=x">Ad</a></div>' +
        '</div></body></html>',
    );

    const error = await provider
      .search('ai news', { limit: 3, signal: new AbortController().signal })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ScrapeSearchError);
    expect((error as ScrapeSearchError).context.code).toBe('empty-results');
  });

  it('respects the limit by truncating extra rows', async () => {
    const provider = providerFor(fixture('duckduckgo-serp.html'));

    const rows = await provider.search('ai news', {
      limit: 2,
      signal: new AbortController().signal,
    });

    expect(rows).toHaveLength(2);
  });

  it('throws a typed anomaly-challenge error on the anti-bot page', async () => {
    const provider = providerFor(fixture('duckduckgo-anomaly.html'));

    const error = await provider
      .search('ai news', { limit: 3, signal: new AbortController().signal })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ScrapeSearchError);
    const err = error as ScrapeSearchError;
    expect(err.message).toContain('anti-bot challenge');
    expect(err.context.code).toBe('anomaly-challenge');
  });

  it('throws empty-results when a normal page yields no rows', async () => {
    const provider = providerFor('<html><body><div class="serp"></div></body></html>');

    const error = await provider
      .search('ai news', { limit: 3, signal: new AbortController().signal })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ScrapeSearchError);
    expect((error as ScrapeSearchError).context.code).toBe('empty-results');
  });

  it('surfaces an ethics-gate refusal as a first-class ScrapeSearchError', async () => {
    const provider = providerFor(
      fixture('duckduckgo-serp.html'),
      refuseGate('blocklist', 'Host is in the ads blocklist'),
    );

    const error = await provider
      .search('ai news', { limit: 3, signal: new AbortController().signal })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ScrapeSearchError);
    const err = error as ScrapeSearchError;
    expect(err.message).toContain('blocklist');
    expect(err.context.code).toContain('ethics-refused');
  });
});
