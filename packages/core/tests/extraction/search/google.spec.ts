import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ScrapeSearchError } from '../../../src/extraction/search/errors.js';
import { GoogleSearchProvider } from '../../../src/extraction/search/google.js';
import { ScrapeTransport } from '../../../src/extraction/search/scrape-transport.js';

import { fakeBrowserProvider, passGate, refuseGate, silentLogger } from './helpers.js';

function fixture(name: string): string {
  return readFileSync(resolve(import.meta.dirname, 'fixtures', name), 'utf8');
}

function providerFor(html: string, gate = passGate): GoogleSearchProvider {
  const transport = new ScrapeTransport({
    browserProvider: fakeBrowserProvider(html).provider,
    ethicsGate: gate,
    logger: silentLogger,
  });
  return new GoogleSearchProvider({ transport });
}

describe('@no-llm extraction/search/google', () => {
  it('parses organic result blocks with correct ranks from the SERP fixture', async () => {
    const provider = providerFor(fixture('google-serp.html'));

    const rows = await provider.search('ai news', {
      limit: 3,
      signal: new AbortController().signal,
    });

    expect(rows).toHaveLength(3);
    expect(rows[0]?.title).toBe('First Google Result');
    expect(rows[0]?.snippet).toBe('First Google snippet text describing the page.');
    expect(rows[0]?.source).toBe('google');
    expect(rows.map((r) => r.rank)).toEqual([0, 1, 2]);
  });

  it('unwraps /url?q= redirect hrefs to the target url', async () => {
    const provider = providerFor(fixture('google-serp.html'));

    const rows = await provider.search('ai news', {
      limit: 3,
      signal: new AbortController().signal,
    });

    expect(rows[1]?.url).toBe('https://example.com/two');
  });

  it('returns a typed anomaly error on the consent/anti-bot page', async () => {
    const provider = providerFor(fixture('google-consent.html'));

    const error = await provider
      .search('ai news', { limit: 3, signal: new AbortController().signal })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ScrapeSearchError);
    expect((error as ScrapeSearchError).context.code).toBe('anomaly-challenge');
  });

  it('returns an empty array (not an error) for a genuine no-results page', async () => {
    const provider = providerFor(fixture('google-empty.html'));

    const rows = await provider.search('zzzznomatchqueryzzzz', {
      limit: 3,
      signal: new AbortController().signal,
    });

    expect(rows).toEqual([]);
  });

  it('passes an ethics-gate refusal through as a ScrapeSearchError', async () => {
    const provider = providerFor(
      fixture('google-serp.html'),
      refuseGate('robots', 'Disallowed by robots.txt at "www.google.com"'),
    );

    const error = await provider
      .search('ai news', { limit: 3, signal: new AbortController().signal })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ScrapeSearchError);
    expect((error as ScrapeSearchError).context.code).toContain('ethics-refused');
  });

  it('respects the limit', async () => {
    const provider = providerFor(fixture('google-serp.html'));

    const rows = await provider.search('ai news', {
      limit: 1,
      signal: new AbortController().signal,
    });

    expect(rows).toHaveLength(1);
  });
});
