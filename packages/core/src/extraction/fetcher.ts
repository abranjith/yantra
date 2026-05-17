import { request } from 'undici';

import type { BrowserProvider } from '../browser/types.js';

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
      readonly kind: 'timeout' | 'http-status' | 'network' | 'too-large';
      readonly statusCode?: number;
    },
  ) {
    super(message);
  }
}

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
    this.maxBodyBytes = options.maxBodyBytes ?? 5 * 1024 * 1024;
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
  readonly browserProvider: BrowserProvider;
}

/**
 * Browser fallback fetcher used for JS-heavy pages.
 */
export class BrowserFallbackFetcher implements ContentFetcher {
  private readonly browserProvider: BrowserProvider;

  public constructor(options: BrowserFallbackFetcherOptions) {
    this.browserProvider = options.browserProvider;
  }

  public async fetch(
    url: string,
    _opts: { timeoutMs: number; signal: AbortSignal },
  ): Promise<FetchedDoc> {
    const startedAt = Date.now();
    const session = await this.browserProvider.launch({
      profile: { kind: 'ephemeral' },
      headless: true,
    });

    try {
      const page = await session.newPage();
      await page.goto(url, { waitUntil: 'networkidle2' });
      const html = await page.evaluate(() => document.documentElement?.outerHTML ?? '');

      return {
        url,
        finalUrl: page.url(),
        fetchedAt: new Date().toISOString(),
        contentType: 'text/html',
        html,
        statusCode: 200,
        fetchMode: 'browser',
        elapsedMs: Date.now() - startedAt,
      };
    } finally {
      await session.close();
    }
  }
}

export interface HybridContentFetcherOptions {
  readonly httpFetcher: ContentFetcher;
  readonly browserFetcher: ContentFetcher;
}

/**
 * Hybrid fetcher that escalates to browser mode for likely JS-heavy pages.
 */
export class HybridContentFetcher implements ContentFetcher {
  private readonly httpFetcher: ContentFetcher;
  private readonly browserFetcher: ContentFetcher;

  public constructor(options: HybridContentFetcherOptions) {
    this.httpFetcher = options.httpFetcher;
    this.browserFetcher = options.browserFetcher;
  }

  public async fetch(
    url: string,
    opts: { timeoutMs: number; signal: AbortSignal },
  ): Promise<FetchedDoc> {
    const doc = await this.httpFetcher.fetch(url, opts);
    if (shouldEscalateToBrowser(doc)) {
      return this.browserFetcher.fetch(url, opts);
    }

    return doc;
  }
}

function shouldEscalateToBrowser(doc: FetchedDoc): boolean {
  const contentType = (doc.contentType ?? '').toLowerCase();
  if (!contentType.includes('text/html')) {
    return false;
  }

  if (doc.html.length >= 10_000) {
    return false;
  }

  const lower = doc.html.toLowerCase();
  const hasScriptSrc = lower.includes('<script') && lower.includes('src=');
  const hasSemanticRoot = lower.includes('<article') || lower.includes('<main');
  return hasScriptSrc && !hasSemanticRoot;
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
