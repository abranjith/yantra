import { request } from 'undici';

import { YANTRA_KEYCHAIN_SERVICE, type KeychainProvider } from '../../secrets/keychain.js';
import type { SearchResult } from '../types.js';

import { RateLimitError, SearchProviderError, TavilyAuthError } from './errors.js';
import type { SearchProvider } from './provider.js';

interface TavilyResultWire {
  readonly url?: string;
  readonly title?: string;
  readonly content?: string;
  readonly published_date?: string;
}

interface TavilyResponseWire {
  readonly results?: readonly TavilyResultWire[];
}

export interface TavilySearchProviderOptions {
  readonly keychain: KeychainProvider;
  readonly keychainService?: string;
  readonly endpoint?: string;
  readonly requestFn?: typeof request;
}

/**
 * Tavily-backed search provider.
 */
export class TavilySearchProvider implements SearchProvider {
  public readonly name = 'tavily' as const;

  private readonly keychain: KeychainProvider;
  private readonly keychainService: string;
  private readonly endpoint: string;
  private readonly requestFn: typeof request;

  public constructor(options: TavilySearchProviderOptions) {
    this.keychain = options.keychain;
    this.keychainService = options.keychainService ?? YANTRA_KEYCHAIN_SERVICE;
    this.endpoint = options.endpoint ?? 'https://api.tavily.com/search';
    this.requestFn = options.requestFn ?? request;
  }

  public async search(
    query: string,
    opts: { limit: number; signal: AbortSignal },
  ): Promise<readonly SearchResult[]> {
    const apiKey = await this.keychain.get(this.keychainService, 'tavily.api_key');
    if (!apiKey) {
      throw new TavilyAuthError('Tavily API key is missing from keychain.', {
        provider: this.name,
        code: 'missing-api-key',
      });
    }

    const response = await this.requestFn(this.endpoint, {
      method: 'POST',
      signal: opts.signal,
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results: Math.max(1, opts.limit),
        search_depth: 'basic',
      }),
    });

    const host = safeHost(this.endpoint);
    if (response.statusCode === 401 || response.statusCode === 403) {
      throw new TavilyAuthError('Tavily rejected the request credentials.', {
        provider: this.name,
        statusCode: response.statusCode,
        host,
      });
    }

    if (response.statusCode === 429) {
      throw new RateLimitError('Tavily rate limit exceeded.', {
        provider: this.name,
        statusCode: response.statusCode,
        host,
        retryAfter: firstHeader(response.headers['retry-after']),
      });
    }

    if (response.statusCode >= 400) {
      throw new SearchProviderError(`Tavily request failed with HTTP ${response.statusCode}.`, {
        provider: this.name,
        statusCode: response.statusCode,
        host,
      });
    }

    let payload: TavilyResponseWire;
    try {
      payload = JSON.parse(await response.body.text()) as TavilyResponseWire;
    } catch (error) {
      throw new SearchProviderError('Failed to parse Tavily response JSON.', {
        provider: this.name,
        host,
        code: `parse-error:${error instanceof Error ? error.message : String(error)}`,
      });
    }

    const rows = payload.results;
    if (!isTavilyResults(rows)) {
      throw new SearchProviderError('Tavily response is missing results[].', {
        provider: this.name,
        host,
        code: 'invalid-shape',
      });
    }

    return rows
      .map((row, rank): SearchResult | null => {
        if (!row.url || typeof row.url !== 'string') {
          return null;
        }

        return {
          url: row.url,
          title: typeof row.title === 'string' ? row.title : null,
          snippet: typeof row.content === 'string' ? row.content : null,
          source: this.name,
          rank,
          publishedAt: toIsoOrNull(row.published_date),
        };
      })
      .filter((row): row is SearchResult => row !== null);
  }
}

function toIsoOrNull(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
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

function isTavilyResults(value: unknown): value is readonly TavilyResultWire[] {
  return Array.isArray(value);
}
