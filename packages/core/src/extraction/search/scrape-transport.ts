import { PageTimeoutError, type PageSource } from '../../browser/page-source.js';
import type { Logger } from '../../browser/types.js';
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
  /** Where SERP renders get their page (the run's pool, or one launch per use). */
  readonly pages: PageSource;
  readonly ethicsGate: SearchEthicsGate;
  readonly logger: Logger;
}

export interface FetchSerpOptions {
  /** Aborts the fetch when the pipeline budget is exhausted. */
  readonly signal: AbortSignal;
  /** The requesting provider name — used only for error context. */
  readonly provider: SearchProviderName;
  /** Ceiling on the SERP render; defaults to {@link DEFAULT_SERP_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
}

/**
 * Default ceiling on one SERP render. Before FEAT-050 a render had no deadline
 * of its own; the agent's per-tool timeout (default 45 s) still bounds the
 * whole search above this.
 */
export const DEFAULT_SERP_TIMEOUT_MS = 30_000;

/**
 * The shared browser-scrape transport for search providers. Owns the mechanical
 * concerns — ethics-gate enforcement, taking a page, navigation, and full-HTML
 * capture — while leaving SERP parsing and anomaly interpretation to the
 * individual providers (`google.ts`, `duckduckgo.ts`) that compose it. The page
 * comes from a {@link PageSource}: an agentic run's shared pool, so a run's
 * searches no longer launch one Chrome each. The core browser launcher owns the
 * shared user-simulation policy, so this path cannot drift from agentic or
 * deterministic browser work.
 */
export class ScrapeTransport {
  private readonly pages: PageSource;
  private readonly ethicsGate: SearchEthicsGate;
  private readonly logger: Logger;

  public constructor(deps: ScrapeTransportDeps) {
    this.pages = deps.pages;
    this.ethicsGate = deps.ethicsGate;
    this.logger = deps.logger;
  }

  /**
   * Fetches the rendered HTML of a SERP URL through Chrome. Runs the ethics gate
   * before taking a page and honors the abort signal and render deadline.
   * Returns the page's full HTML; providers parse it themselves.
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

    try {
      return await this.pages.withPage(
        async (page) => {
          await page.goto(url, { waitUntil: 'domcontentloaded' });
          return page.evaluate(() => document.documentElement.outerHTML);
        },
        { timeoutMs: opts.timeoutMs ?? DEFAULT_SERP_TIMEOUT_MS, signal: opts.signal },
      );
    } catch (error) {
      if (error instanceof ScrapeSearchError) {
        throw error;
      }
      if (error instanceof PageTimeoutError) {
        throw new ScrapeSearchError('Search results page timed out.', {
          provider: opts.provider,
          host: safeHost(url),
          code: 'timeout',
        });
      }
      if (opts.signal.aborted) {
        throw new ScrapeSearchError('Search aborted while rendering results.', {
          provider: opts.provider,
          host: safeHost(url),
          code: 'aborted',
        });
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
