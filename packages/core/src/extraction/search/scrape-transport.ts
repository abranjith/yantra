import type { BrowserProvider, Logger } from '../../browser/types.js';
import type { SearchProviderName } from '../types.js';

import { ScrapeSearchError } from './errors.js';

/**
 * Minimal ethics-gate surface the scrape transport needs: a per-URL check that
 * either passes or refuses with a reason/detail. Structurally compatible with
 * the ask pipeline's `AskEthicsGate`.
 */
export interface SearchEthicsGate {
  checkUrl(url: string): Promise<{ ok: true } | { ok: false; reason: string; detail: string }>;
}

export interface ScrapeTransportDeps {
  readonly browserProvider: BrowserProvider;
  readonly ethicsGate: SearchEthicsGate;
  readonly logger: Logger;
}

export interface FetchSerpOptions {
  /** Aborts the fetch when the pipeline budget is exhausted. */
  readonly signal: AbortSignal;
  /** The requesting provider name — used only for error context. */
  readonly provider: SearchProviderName;
}

/**
 * The shared browser-scrape transport for search providers. Owns the mechanical
 * concerns — ethics-gate enforcement, browser launch, navigation, and full-HTML
 * capture — while leaving SERP parsing and anomaly interpretation to the
 * individual providers (`google.ts`, `duckduckgo.ts`) that compose it. The core
 * browser launcher owns the shared user-simulation policy, so this path cannot
 * drift from agentic or deterministic browser work.
 */
export class ScrapeTransport {
  private readonly browserProvider: BrowserProvider;
  private readonly ethicsGate: SearchEthicsGate;
  private readonly logger: Logger;

  public constructor(deps: ScrapeTransportDeps) {
    this.browserProvider = deps.browserProvider;
    this.ethicsGate = deps.ethicsGate;
    this.logger = deps.logger;
  }

  /**
   * Fetches the rendered HTML of a SERP URL through Chrome. Runs the ethics gate
   * before any browser launch and honors the abort signal. Returns the page's
   * full HTML; providers parse it themselves.
   *
   * @throws {ScrapeSearchError} when the ethics gate refuses the URL, the fetch
   *   is aborted, or the browser navigation fails.
   */
  public async fetchSerp(url: string, opts: FetchSerpOptions): Promise<string> {
    const ethicsDecision = await this.ethicsGate.checkUrl(url);
    if (!ethicsDecision.ok) {
      throw new ScrapeSearchError(
        `Search URL refused by ethics gate [${ethicsDecision.reason}: ${ethicsDecision.detail}] ` +
          `(host: ${safeHost(url)}).`,
        {
          provider: opts.provider,
          host: safeHost(url),
          code: `ethics-refused:${ethicsDecision.reason}:${ethicsDecision.detail}`,
        },
      );
    }

    if (opts.signal.aborted) {
      throw new ScrapeSearchError('Search aborted before browser launch.', {
        provider: opts.provider,
        host: safeHost(url),
        code: 'aborted',
      });
    }

    const session = await this.browserProvider.launch({
      profile: { kind: 'ephemeral' },
      headless: true,
    });

    try {
      const page = await session.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      return await page.evaluate(() => document.documentElement.outerHTML);
    } catch (error) {
      if (error instanceof ScrapeSearchError) {
        throw error;
      }
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error), provider: opts.provider },
        'search serp fetch failed',
      );
      throw new ScrapeSearchError('Search SERP fetch failed.', {
        provider: opts.provider,
        host: safeHost(url),
        code: error instanceof Error ? error.name : 'unknown',
      });
    } finally {
      await session.close();
    }
  }
}

export function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
