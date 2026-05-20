import type { BrowserProvider, Logger } from '../../browser/types.js';
import type { SearchResult } from '../types.js';

import { BrowserSearchError } from './errors.js';
import type { SearchProvider } from './provider.js';

export interface BrowserSearchEthicsGate {
  checkUrl(url: string): Promise<{ ok: true } | { ok: false; reason: string; detail: string }>;
}

export interface BrowserSearchProviderOptions {
  readonly browserProvider: BrowserProvider;
  readonly ethicsGate: BrowserSearchEthicsGate;
  readonly logger: Logger;
  readonly endpoint?: string;
}

interface BrowserSearchRow {
  readonly href: string;
  readonly title: string;
  readonly snippet: string | null;
}

interface BrowserSearchPageResult {
  readonly rows: readonly BrowserSearchRow[];
  /** True when DuckDuckGo served its anti-bot anomaly/challenge page. */
  readonly blocked: boolean;
}

/**
 * Chrome flags that make the headless session look like an ordinary desktop
 * browser. DuckDuckGo's anomaly detector challenges requests whose User-Agent
 * advertises "HeadlessChrome" or that expose `navigator.webdriver` (set by
 * puppeteer's default `--enable-automation`). Without these, the html endpoint
 * returns a CAPTCHA page with zero result rows instead of search results.
 */
function antiFingerprintArgs(chromeMajor: number | undefined): readonly string[] {
  const major = chromeMajor && chromeMajor > 0 ? chromeMajor : 124;
  const userAgent =
    `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ` +
    `(KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
  return [
    `--user-agent=${userAgent}`,
    '--disable-blink-features=AutomationControlled',
    '--lang=en-US,en',
  ];
}

/**
 * Browser-only search fallback using DuckDuckGo's HTML endpoint.
 */
export class BrowserSearchProvider implements SearchProvider {
  public readonly name = 'browser' as const;

  private readonly browserProvider: BrowserProvider;
  private readonly ethicsGate: BrowserSearchEthicsGate;
  private readonly logger: Logger;
  private readonly endpoint: string;

  public constructor(options: BrowserSearchProviderOptions) {
    this.browserProvider = options.browserProvider;
    this.ethicsGate = options.ethicsGate;
    this.logger = options.logger;
    this.endpoint = options.endpoint ?? 'https://html.duckduckgo.com/html/';
  }

  public async search(
    query: string,
    opts: { limit: number; signal: AbortSignal },
  ): Promise<readonly SearchResult[]> {
    const searchUrl = this.buildSearchUrl(query);
    const ethicsDecision = await this.ethicsGate.checkUrl(searchUrl);
    if (!ethicsDecision.ok) {
      throw new BrowserSearchError(
        `Browser search URL refused by ethics gate [${ethicsDecision.reason}: ${ethicsDecision.detail}] (host: ${safeHost(searchUrl)}).`,
        {
          provider: this.name,
          host: safeHost(searchUrl),
          code: `ethics-refused:${ethicsDecision.reason}:${ethicsDecision.detail}`,
        },
      );
    }

    if (opts.signal.aborted) {
      throw new BrowserSearchError('Browser search aborted before launch.', {
        provider: this.name,
        host: safeHost(searchUrl),
        code: 'aborted',
      });
    }

    const detected = await this.browserProvider.detectChrome().catch(() => null);
    const session = await this.browserProvider.launch({
      profile: { kind: 'ephemeral' },
      headless: true,
      extraArgs: [...antiFingerprintArgs(detected?.majorVersion)],
    });

    try {
      const page = await session.newPage();
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded' });

      const { rows, blocked } = await page.evaluate((): BrowserSearchPageResult => {
        const blockedPage =
          document.querySelector(
            '#challenge-form, .anomaly-modal__modal, form[action*="anomaly"]',
          ) !== null;
        const links = Array.from(document.querySelectorAll('a.result__a'));
        const mappedRows = links.map((anchor) => {
          const result = anchor.closest('.result');
          const snippetElement = result?.querySelector('.result__snippet');
          const snippet = snippetElement?.textContent ?? null;
          return {
            href: anchor.getAttribute('href') ?? '',
            title: anchor.textContent?.trim() ?? '',
            snippet: snippet?.trim() ?? null,
          };
        });
        return { rows: mappedRows, blocked: blockedPage };
      });

      const mapped = rows
        .map((row, rank): SearchResult | null => mapResultRow(row, rank, this.endpoint))
        .filter((row): row is SearchResult => row !== null)
        .slice(0, Math.max(1, opts.limit));

      if (mapped.length === 0) {
        if (blocked) {
          throw new BrowserSearchError(
            'DuckDuckGo served an anti-bot challenge instead of search results. ' +
              'The automated browser was flagged; retry shortly, or configure a keyed ' +
              'search provider (`--provider tavily` or `--provider brave`) to avoid scraping.',
            {
              provider: this.name,
              host: safeHost(searchUrl),
              code: 'anomaly-challenge',
            },
          );
        }
        throw new BrowserSearchError('Browser search did not return result rows.', {
          provider: this.name,
          host: safeHost(searchUrl),
          code: 'empty-results',
        });
      }

      return mapped;
    } catch (error) {
      if (error instanceof BrowserSearchError) {
        throw error;
      }

      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'browser search failed',
      );
      throw new BrowserSearchError('Browser search failed.', {
        provider: this.name,
        host: safeHost(searchUrl),
        code: error instanceof Error ? error.name : 'unknown',
      });
    } finally {
      await session.close();
    }
  }

  private buildSearchUrl(query: string): string {
    const url = new URL(this.endpoint);
    url.searchParams.set('q', query);
    return url.toString();
  }
}

function mapResultRow(row: BrowserSearchRow, rank: number, endpoint: string): SearchResult | null {
  if (!row.href || !row.title) {
    return null;
  }

  const url = canonicalizeDdgHref(row.href, endpoint);
  return {
    url,
    title: row.title,
    snippet: row.snippet,
    source: 'browser',
    rank,
    publishedAt: null,
  };
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

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
