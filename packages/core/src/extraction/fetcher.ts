import { request } from 'undici';

import { PageTimeoutError, type PageSource } from '../browser/page-source.js';

import { classifyResponse, type ChallengeMarker } from './response-classifier.js';
import type { FetchedDoc } from './types.js';

export interface ContentFetcher {
  fetch(url: string, opts: { timeoutMs: number; signal: AbortSignal }): Promise<FetchedDoc>;
}

export class FetchError extends Error {
  public override readonly name = 'FetchError';

  public constructor(
    message: string,
    public readonly context: {
      readonly url: string;
      readonly kind: 'timeout' | 'http-status' | 'network' | 'too-large' | 'challenge';
      readonly statusCode?: number;
      /** For `challenge`: which tier was served the human-verification page. */
      readonly tier?: 'http' | 'browser';
      /** For `challenge`: the documented marker that identified it. */
      readonly marker?: ChallengeMarker;
    },
  ) {
    super(message);
  }
}

/**
 * The most body bytes one read takes. Shared by the HTTP fetcher and the live
 * page snapshot, so a browser read can never hand the analyzer more than a
 * fetched read could.
 */
export const DEFAULT_MAX_BODY_BYTES = 5 * 1024 * 1024;

export interface HttpFetcherOptions {
  readonly requestFn?: typeof request;
  readonly maxBodyBytes?: number;
}

/**
 * HTTP-first content fetcher with timeout + body-size guards.
 */
export class HttpFetcher implements ContentFetcher {
  private readonly requestFn: typeof request;
  private readonly maxBodyBytes: number;

  public constructor(options: HttpFetcherOptions = {}) {
    this.requestFn = options.requestFn ?? request;
    this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  }

  public async fetch(
    url: string,
    opts: { timeoutMs: number; signal: AbortSignal },
  ): Promise<FetchedDoc> {
    const startedAt = Date.now();
    const timeoutController = new AbortController();
    const signal = mergeSignals(opts.signal, timeoutController.signal);
    const timer = setTimeout(() => timeoutController.abort(), opts.timeoutMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }

    try {
      const response = await this.requestFn(url, {
        method: 'GET',
        signal,
        headersTimeout: opts.timeoutMs,
        bodyTimeout: opts.timeoutMs,
        headers: {
          'user-agent': 'YantraBot/0.1 (+https://yantra.dev/bot)',
          accept: 'text/html,application/xhtml+xml',
        },
      });

      if (response.statusCode >= 400) {
        throw new FetchError(`HTTP ${response.statusCode} while fetching content.`, {
          url,
          kind: 'http-status',
          statusCode: response.statusCode,
        });
      }

      const html = await readBodyWithLimit(response.body, this.maxBodyBytes, url);
      const elapsedMs = Date.now() - startedAt;

      return {
        url,
        finalUrl: url,
        fetchedAt: new Date().toISOString(),
        contentType: firstHeader(response.headers['content-type']),
        html,
        statusCode: response.statusCode,
        fetchMode: 'http',
        elapsedMs,
      };
    } catch (error) {
      if (error instanceof FetchError) {
        throw error;
      }

      if (timeoutController.signal.aborted) {
        throw new FetchError(`Fetch timed out after ${opts.timeoutMs}ms.`, {
          url,
          kind: 'timeout',
        });
      }

      throw new FetchError('Network failure while fetching content.', {
        url,
        kind: 'network',
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

export interface BrowserFallbackFetcherOptions {
  /**
   * Where the render gets its page: the run's shared page pool in an agentic
   * run, or `launchPerUsePageSource(provider)` for the deterministic paths.
   */
  readonly pages: PageSource;
}

/**
 * Browser fallback fetcher used for JS-heavy pages.
 *
 * A rendered page is only evidence when the server actually served one. Chrome
 * renders its own "This page isn't working / HTTP ERROR 4xx" interstitial for an
 * error response, and that interstitial extracts as perfectly readable prose —
 * so reporting every navigation as `200` published error-page text ("If the
 * problem continues, contact the site owner.") as a source excerpt. The status
 * rule here is deliberately identical to {@link HttpFetcher}'s: one fetch
 * contract, two transports.
 *
 * The render honors the caller's `timeoutMs` and `signal` (FEAT-050): it used
 * to ignore both and wait for `networkidle2` however long that took. A render
 * past its deadline rejects with a `timeout` {@link FetchError} and its page is
 * closed; an aborted render rejects with the signal's reason.
 */
export class BrowserFallbackFetcher implements ContentFetcher {
  private readonly pages: PageSource;

  public constructor(options: BrowserFallbackFetcherOptions) {
    this.pages = options.pages;
  }

  public async fetch(
    url: string,
    opts: { timeoutMs: number; signal: AbortSignal },
  ): Promise<FetchedDoc> {
    const startedAt = Date.now();
    try {
      return await this.pages.withPage(
        async (page) => {
          const response = await page.goto(url, { waitUntil: 'networkidle2' });
          const statusCode = navigationStatus(response);
          if (statusCode !== null && statusCode >= 400) {
            throw new FetchError(`HTTP ${statusCode} while rendering content.`, {
              url,
              kind: 'http-status',
              statusCode,
            });
          }
          const html = await page.evaluate(() => document.documentElement?.outerHTML ?? '');
          return {
            url,
            finalUrl: page.url(),
            fetchedAt: new Date().toISOString(),
            contentType: 'text/html',
            html,
            // A page facade that reports no response (data: URLs, same-document
            // navigation, test fakes) is reported as it always was.
            statusCode: statusCode ?? 200,
            fetchMode: 'browser' as const,
            elapsedMs: Date.now() - startedAt,
          };
        },
        { timeoutMs: opts.timeoutMs, signal: opts.signal },
      );
    } catch (error) {
      if (error instanceof PageTimeoutError) {
        throw new FetchError(`Browser render timed out after ${opts.timeoutMs}ms.`, {
          url,
          kind: 'timeout',
        });
      }
      throw error;
    }
  }
}

/**
 * HTTP status of a navigation, or null when the page facade does not expose one.
 * `Page.goto` is typed as returning `unknown` so fakes can stay minimal; the
 * production Puppeteer page returns an `HTTPResponse` carrying `status()`.
 */
function navigationStatus(response: unknown): number | null {
  if (typeof response !== 'object' || response === null) {
    return null;
  }
  const status = (response as { status?: unknown }).status;
  if (typeof status !== 'function') {
    return null;
  }
  const code = (status as () => unknown).call(response);
  return typeof code === 'number' && Number.isFinite(code) ? code : null;
}

/**
 * One tier decision inside {@link HybridContentFetcher}, for the run's audit
 * and health ledger. Carries a bare hostname only — never a path, query, or
 * page text.
 */
export type FetchTierEvent =
  | {
      readonly kind: 'escalated';
      readonly reason: 'js-shell' | 'http-error' | 'http-challenge';
      readonly host: string;
    }
  | {
      readonly kind: 'challenge';
      readonly tier: 'http' | 'browser';
      readonly marker: ChallengeMarker;
      readonly host: string;
    };

export interface HybridContentFetcherOptions {
  readonly httpFetcher: ContentFetcher;
  readonly browserFetcher: ContentFetcher;
  /** Receives every escalation and challenge, in order. Must not throw. */
  readonly onTierEvent?: (event: FetchTierEvent) => void;
}

/**
 * HTTP first, escalating to one browser render when the HTTP tier cannot
 * serve readable content — and classifying every response before anything
 * extracts it (FEAT-050, G10):
 *
 * 1. HTTP fetch, then {@link classifyResponse}.
 * 2. `challenge` → one browser render. This is policy (b), signed off by the
 *    user on 2026-10-10 (plan_task_fidelity §12 item 4): the honest
 *    `YantraBot` client was refused, and the product's normal browser may look
 *    once — no spoofing, solving, waiting, or retry.
 * 3. `js-shell` → one render, as before.
 * 4. HTTP error or network failure → one render, as before.
 * 5. The rendered document is classified too. A browser-tier `challenge` is
 *    terminal: a `challenge` {@link FetchError}, never content.
 * 6. A rendered `js-shell` is returned as content: a second render would not
 *    help, and extraction reports what it found.
 *
 * The browser path never retries, never waits for a challenge to clear, and
 * changes nothing about the browser's identity (plan §6).
 */
export class HybridContentFetcher implements ContentFetcher {
  private readonly httpFetcher: ContentFetcher;
  private readonly browserFetcher: ContentFetcher;
  private readonly onTierEvent: (event: FetchTierEvent) => void;

  public constructor(options: HybridContentFetcherOptions) {
    this.httpFetcher = options.httpFetcher;
    this.browserFetcher = options.browserFetcher;
    this.onTierEvent = options.onTierEvent ?? (() => undefined);
  }

  public async fetch(
    url: string,
    opts: { timeoutMs: number; signal: AbortSignal },
  ): Promise<FetchedDoc> {
    const host = hostOf(url);
    let reason: 'js-shell' | 'http-error' | 'http-challenge';
    try {
      const doc = await this.httpFetcher.fetch(url, opts);
      const verdict = classifyResponse(doc);
      if (verdict.kind === 'content') return doc;
      if (verdict.kind === 'challenge') {
        this.onTierEvent({ kind: 'challenge', tier: 'http', marker: verdict.marker, host });
        reason = 'http-challenge';
      } else {
        reason = 'js-shell';
      }
    } catch {
      // swallow-ok: any HTTP-tier failure escalates to the one browser render,
      // whose own outcome (or error) is what the caller receives.
      reason = 'http-error';
    }

    this.onTierEvent({ kind: 'escalated', reason, host });
    const rendered = await this.browserFetcher.fetch(url, opts);
    const verdict = classifyResponse(rendered);
    if (verdict.kind === 'challenge') {
      this.onTierEvent({ kind: 'challenge', tier: 'browser', marker: verdict.marker, host });
      throw new FetchError('The page served a human-verification challenge.', {
        url,
        kind: 'challenge',
        tier: 'browser',
        marker: verdict.marker,
      });
    }
    return rendered;
  }
}

/** Bare hostname for tier events; an unparseable URL yields an empty host. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    // swallow-ok: tier events tolerate an unknown host.
    return '';
  }
}

function firstHeader(value: string | string[] | undefined): string | null {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value) && value.length > 0) {
    return value[0] ?? null;
  }
  return null;
}

function mergeSignals(left: AbortSignal, right: AbortSignal): AbortSignal {
  const merged = new AbortController();
  if (left.aborted || right.aborted) {
    merged.abort();
    return merged.signal;
  }

  left.addEventListener(
    'abort',
    () => {
      merged.abort();
    },
    { once: true },
  );
  right.addEventListener(
    'abort',
    () => {
      merged.abort();
    },
    { once: true },
  );
  return merged.signal;
}

async function readBodyWithLimit(
  body: AsyncIterable<Buffer | Uint8Array>,
  maxBytes: number,
  url: string,
): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of body) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      throw new FetchError(`Fetched body exceeded ${maxBytes} bytes.`, {
        url,
        kind: 'too-large',
      });
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks).toString('utf8');
}
