import { PageTimeoutError, type PageSource } from '../../browser/page-source.js';
import type { Logger, Page } from '../../browser/types.js';
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
 * A search run through a page's own search form, the way a person runs it:
 * open the page, enter the query in its search field, submit.
 */
export interface SerpFormSubmission {
  /** The page carrying the search form. Loaded without the query. */
  readonly pageUrl: string;
  /** `name` of the visible text field that takes the query. */
  readonly field: string;
  readonly query: string;
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
    return this.render(url, opts, async (page) => {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      return page.evaluate(() => document.documentElement.outerHTML);
    });
  }

  /**
   * Runs a search through the search page's own form and returns the results
   * page's full HTML. For an endpoint whose interface submits the query (a
   * POST form) rather than linking to it: a direct GET carrying the query is a
   * request no person's browser makes there, and such endpoints answer it with
   * an anti-bot challenge. The form's target passes the ethics gate too, since
   * submitting navigates there. Same abort, deadline, and failure mapping as
   * {@link fetchSerp}.
   *
   * @throws {ScrapeSearchError} `search-form-missing` when the page has no
   *   visible text field named `field` inside a form, plus every
   *   {@link fetchSerp} failure.
   */
  public async submitSerpForm(form: SerpFormSubmission, opts: FetchSerpOptions): Promise<string> {
    return this.render(form.pageUrl, opts, async (page) => {
      await page.goto(form.pageUrl, { waitUntil: 'domcontentloaded' });
      const action = await page.evaluate(searchFormAction, form.field);
      if (action === null) {
        throw new ScrapeSearchError(`Search page has no form field named "${form.field}".`, {
          provider: opts.provider,
          host: safeHost(form.pageUrl),
          code: 'search-form-missing',
        });
      }
      await this.assertAllowed(action, opts.provider);
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
        page.evaluate(submitSearchForm, { field: form.field, query: form.query }),
      ]);
      return page.evaluate(() => document.documentElement.outerHTML);
    });
  }

  /** Gate, abort check, then `work` on a page under the render deadline. */
  private async render(
    url: string,
    opts: FetchSerpOptions,
    work: (page: Page) => Promise<string>,
  ): Promise<string> {
    await this.assertAllowed(url, opts.provider);

    if (opts.signal.aborted) {
      throw new ScrapeSearchError('Search aborted before browser launch.', {
        provider: opts.provider,
        host: safeHost(url),
        code: 'aborted',
      });
    }

    try {
      return await this.pages.withPage(work, {
        timeoutMs: opts.timeoutMs ?? DEFAULT_SERP_TIMEOUT_MS,
        signal: opts.signal,
      });
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

  private async assertAllowed(url: string, provider: SearchProviderName): Promise<void> {
    const ethicsDecision = await this.ethicsGate.checkUrl(url);
    if (!ethicsDecision.ok) {
      throw new ScrapeSearchError(
        `Search URL refused by ethics gate [${ethicsDecision.reason}: ${ethicsDecision.detail}] ` +
          `(host: ${safeHost(url)}).`,
        {
          provider,
          host: safeHost(url),
          code: `ethics-refused:${ethicsDecision.reason}:${ethicsDecision.detail}`,
        },
      );
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

/**
 * In-page, read-only: the absolute URL the form owning the visible text field
 * `field` submits to, or null when no form has one. Shipped to the page by
 * source, so it must stay self-contained.
 *
 * @internal Exported for the real-Chrome transport tests.
 */
export function searchFormAction(field: string): string | null {
  const input = Array.from(document.getElementsByName(field)).find(
    (el): el is HTMLInputElement =>
      el instanceof HTMLInputElement && (el.type === 'text' || el.type === 'search'),
  );
  const form = input?.form ?? null;
  if (form === null) return null;
  // The attribute, not `form.action`: a control named "action" shadows that property.
  return new URL(form.getAttribute('action') ?? '', document.baseURI).href;
}

/**
 * In-page: enters `query` in the visible text field `field` and submits its
 * form through the form's default button, as pressing Enter does, so the
 * request carries the same fields a person's would. Shipped to the page by
 * source, so it must stay self-contained.
 *
 * @internal Exported for the real-Chrome transport tests.
 */
export function submitSearchForm(entry: { readonly field: string; readonly query: string }): void {
  const input = Array.from(document.getElementsByName(entry.field)).find(
    (el): el is HTMLInputElement =>
      el instanceof HTMLInputElement && (el.type === 'text' || el.type === 'search'),
  );
  const form = input?.form ?? null;
  if (input === undefined || form === null) {
    throw new Error(`No search form owns a text field named "${entry.field}".`);
  }
  input.value = entry.query;
  const defaultButton =
    Array.from(form.elements).find(
      (el): el is HTMLButtonElement | HTMLInputElement =>
        (el instanceof HTMLButtonElement && el.type === 'submit') ||
        (el instanceof HTMLInputElement && (el.type === 'submit' || el.type === 'image')),
    ) ?? null;
  // Deferred so this evaluation returns before the navigation replaces its context.
  setTimeout(() => form.requestSubmit(defaultButton), 0);
}
