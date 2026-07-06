import { load } from 'cheerio';

import type { SearchResult } from '../types.js';

import { ScrapeSearchError } from './errors.js';
import type { SearchProvider } from './registry.js';
import { safeHost } from './scrape-transport.js';
import type { ScrapeTransport } from './scrape-transport.js';

export interface GoogleSearchProviderOptions {
  readonly transport: ScrapeTransport;
  readonly endpoint?: string;
}

/**
 * Google search provider. Scrapes the Google SERP through the shared
 * {@link ScrapeTransport}, parsing organic result blocks with cheerio. No API
 * key required, but it carries the highest anti-bot friction of any provider —
 * which is why it is opt-in (not in the default fallback chain). When Google
 * serves a consent / "unusual traffic" / CAPTCHA interstitial we return a typed
 * `anomaly-challenge` error advising a keyed provider; we never attempt to evade
 * the block (memory §General: honor blocks).
 */
export class GoogleSearchProvider implements SearchProvider {
  public readonly name = 'google' as const;

  private readonly transport: ScrapeTransport;
  private readonly endpoint: string;

  public constructor(options: GoogleSearchProviderOptions) {
    this.transport = options.transport;
    this.endpoint = options.endpoint ?? 'https://www.google.com/search';
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

    const { rows, blocked } = parseGoogleHtml(html);

    // Google returning zero organic rows *with* a consent/CAPTCHA interstitial is
    // an anomaly; zero rows on a normal page is simply an empty result set.
    if (rows.length === 0 && blocked) {
      throw new ScrapeSearchError(
        'Google served a consent / anti-bot challenge instead of search results. ' +
          'The automated browser was flagged; retry shortly, or configure a keyed ' +
          'search provider (`--search-provider tavily` or `--search-provider brave`) to avoid scraping.',
        { provider: this.name, host: safeHost(searchUrl), code: 'anomaly-challenge' },
      );
    }

    return rows
      .map((row, rank): SearchResult | null => this.mapRow(row, rank))
      .filter((row): row is SearchResult => row !== null)
      .slice(0, Math.max(1, opts.limit));
  }

  private mapRow(row: GoogleRow, rank: number): SearchResult | null {
    if (!row.href || !row.title) {
      return null;
    }
    return {
      url: canonicalizeGoogleHref(row.href, this.endpoint),
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
    // `hl` (interface locale) is wired from user locale in FEAT-018; plain query
    // for now.
    return url.toString();
  }
}

interface GoogleRow {
  readonly href: string;
  readonly title: string;
  readonly snippet: string | null;
}

interface GoogleParseResult {
  readonly rows: readonly GoogleRow[];
  /** True when Google served a consent / "unusual traffic" / CAPTCHA page. */
  readonly blocked: boolean;
}

/**
 * Parses Google SERP markup into organic result rows and detects the consent /
 * anti-bot interstitial. Exported for the provider contract suite.
 */
export function parseGoogleHtml(html: string): GoogleParseResult {
  const $ = load(html);

  const blocked =
    $('form[action*="consent"], form#captcha-form, #captcha-form, #recaptcha, div.g-recaptcha')
      .length > 0 || /our systems have detected unusual traffic/i.test($('body').text());

  const rows: GoogleRow[] = [];
  $('div.g').each((_index, element) => {
    const block = $(element);
    const anchor = block.find('a[href]').first();
    const href = anchor.attr('href') ?? '';
    const title = block.find('h3').first().text().trim();
    const snippet = block.find('.VwiC3b, .IsZvec, .st').first().text().trim();
    if (!href || !title) {
      return;
    }
    rows.push({ href, title, snippet: snippet.length > 0 ? snippet : null });
  });

  return { rows, blocked };
}

function canonicalizeGoogleHref(href: string, endpoint: string): string {
  try {
    const absolute = new URL(href, endpoint);
    // Google wraps organic links as `/url?q=<target>&...` on some layouts.
    if (absolute.pathname === '/url') {
      const target = absolute.searchParams.get('q') ?? absolute.searchParams.get('url');
      if (target) {
        return target;
      }
    }
    return absolute.toString();
  } catch {
    return href;
  }
}
