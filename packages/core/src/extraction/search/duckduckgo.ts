import { load } from 'cheerio';

import type { SearchResult } from '../types.js';

import { ScrapeSearchError } from './errors.js';
import type { SearchProvider } from './registry.js';
import { safeHost } from './scrape-transport.js';
import type { ScrapeTransport } from './scrape-transport.js';

export interface DuckDuckGoSearchProviderOptions {
  readonly transport: ScrapeTransport;
  readonly endpoint?: string;
}

/**
 * DuckDuckGo search provider. Scrapes DuckDuckGo's HTML endpoint through the
 * shared {@link ScrapeTransport}, parsing organic result rows with cheerio. No
 * API key required. When DuckDuckGo serves its anti-bot anomaly/challenge page
 * we surface a typed `anomaly-challenge` error advising a keyed provider — we
 * never attempt to evade the block (memory §General: honor blocks).
 */
export class DuckDuckGoSearchProvider implements SearchProvider {
  public readonly name = 'duckduckgo' as const;

  private readonly transport: ScrapeTransport;
  private readonly endpoint: string;

  public constructor(options: DuckDuckGoSearchProviderOptions) {
    this.transport = options.transport;
    this.endpoint = options.endpoint ?? 'https://html.duckduckgo.com/html/';
  }

  public async search(
    query: string,
    opts: { limit: number; signal: AbortSignal },
  ): Promise<readonly SearchResult[]> {
    const searchUrl = this.buildSearchUrl(query);
    const html = await this.transport.fetchSerp(searchUrl, {
      signal: opts.signal,
      provider: this.name,
    });

    const { rows, blocked } = parseDuckDuckGoHtml(html);
    const mapped = rows
      .map((row, rank): SearchResult | null => this.mapRow(row, rank))
      .filter((row): row is SearchResult => row !== null)
      .slice(0, Math.max(1, opts.limit));

    if (mapped.length === 0) {
      if (blocked) {
        throw new ScrapeSearchError(
          'DuckDuckGo served an anti-bot challenge instead of search results. ' +
            'The automated browser was flagged; retry shortly, or configure a keyed ' +
            'search provider (`--search-provider tavily` or `--search-provider brave`) to avoid scraping.',
          { provider: this.name, host: safeHost(searchUrl), code: 'anomaly-challenge' },
        );
      }
      throw new ScrapeSearchError('DuckDuckGo search did not return result rows.', {
        provider: this.name,
        host: safeHost(searchUrl),
        code: 'empty-results',
      });
    }

    return mapped;
  }

  private mapRow(row: DuckDuckGoRow, rank: number): SearchResult | null {
    if (!row.href || !row.title) {
      return null;
    }
    return {
      url: canonicalizeDdgHref(row.href, this.endpoint),
      title: row.title,
      snippet: row.snippet,
      source: this.name,
      rank,
      publishedAt: null,
    };
  }

  private buildSearchUrl(query: string): string {
    const url = new URL(this.endpoint);
    url.searchParams.set('q', query);
    return url.toString();
  }
}

interface DuckDuckGoRow {
  readonly href: string;
  readonly title: string;
  readonly snippet: string | null;
}

interface DuckDuckGoParseResult {
  readonly rows: readonly DuckDuckGoRow[];
  /** True when DuckDuckGo served its anti-bot anomaly/challenge page. */
  readonly blocked: boolean;
}

/**
 * Parses DuckDuckGo HTML-endpoint markup into organic result rows and detects
 * the anti-bot challenge interstitial. Exported for the provider contract suite.
 *
 * Sponsored rows are dropped. DuckDuckGo renders them with the very same
 * `result__a` anchor as organic hits — only the row class and the `y.js` ad
 * href distinguish them — and they sit *above* the organic results, so an
 * unfiltered parse hands the top rank to an ad-click tracker. Those hrefs are
 * not pages: they carry kilobytes of click metadata (long enough to trip the
 * 2048-character URL policy), they 400 when fetched outside a real click, and
 * the resulting browser error page was being extracted and published as a
 * Brief source.
 */
export function parseDuckDuckGoHtml(html: string): DuckDuckGoParseResult {
  const $ = load(html);
  const blocked = $('#challenge-form, .anomaly-modal__modal, form[action*="anomaly"]').length > 0;

  const rows: DuckDuckGoRow[] = [];
  $('a.result__a').each((_index, element) => {
    const anchor = $(element);
    const result = anchor.closest('.result');
    const href = anchor.attr('href') ?? '';
    if (result.is(AD_ROW_SELECTOR) || isAdHref(href)) {
      return;
    }
    const snippetText = result.find('.result__snippet').first().text().trim();
    rows.push({
      href,
      title: anchor.text().trim(),
      snippet: snippetText.length > 0 ? snippetText : null,
    });
  });

  return { rows, blocked };
}

/** Row classes DuckDuckGo puts on sponsored results. */
const AD_ROW_SELECTOR = '.result--ad, .result--ad--small, .result--sponsored';

/** Base for resolving DuckDuckGo's protocol-relative (`//host/path`) hrefs. */
const HREF_BASE = 'https://html.duckduckgo.com/html/';

/** True for a DuckDuckGo ad-click tracker href (`//duckduckgo.com/y.js?...`). */
function isAdHref(href: string): boolean {
  try {
    const absolute = new URL(href, HREF_BASE);
    return (
      (absolute.hostname === 'duckduckgo.com' || absolute.hostname.endsWith('.duckduckgo.com')) &&
      absolute.pathname === '/y.js'
    );
  } catch {
    return false;
  }
}

function canonicalizeDdgHref(href: string, endpoint: string): string {
  try {
    const absolute = new URL(href, endpoint);
    if (absolute.hostname.includes('duckduckgo.com') && absolute.pathname === '/l/') {
      const uddg = absolute.searchParams.get('uddg');
      if (uddg) {
        return decodeURIComponent(uddg);
      }
    }
    return absolute.toString();
  } catch {
    return href;
  }
}
