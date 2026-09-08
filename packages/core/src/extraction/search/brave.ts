import { request } from 'undici';

import { YANTRA_KEYCHAIN_SERVICE, type KeychainProvider } from '../../secrets/keychain.js';
import type { SearchResult } from '../types.js';

import { resolveSearchCredential } from './credential.js';
import { RateLimitError, SearchProviderError, TavilyAuthError } from './errors.js';
import type { SearchProvider } from './registry.js';

interface BraveResultWire {
  readonly url?: string;
  readonly title?: string;
  readonly description?: string;
  readonly age?: string;
}

interface BraveResponseWire {
  readonly web?: {
    readonly results?: readonly BraveResultWire[];
  };
}

export interface BraveSearchProviderOptions {
  readonly keychain: KeychainProvider;
  readonly keychainService?: string;
  readonly endpoint?: string;
  readonly requestFn?: typeof request;
}

/**
 * Brave Search API provider.
 */
export class BraveSearchProvider implements SearchProvider {
  public readonly name = 'brave' as const;

  private readonly keychain: KeychainProvider;
  private readonly keychainService: string;
  private readonly endpoint: string;
  private readonly requestFn: typeof request;

  public constructor(options: BraveSearchProviderOptions) {
    this.keychain = options.keychain;
    this.keychainService = options.keychainService ?? YANTRA_KEYCHAIN_SERVICE;
    this.endpoint = options.endpoint ?? 'https://api.search.brave.com/res/v1/web/search';
    this.requestFn = options.requestFn ?? request;
  }

  public async search(
    query: string,
    opts: { limit: number; signal: AbortSignal },
  ): Promise<readonly SearchResult[]> {
    const credential = await resolveSearchCredential('brave', this.keychain, this.keychainService);
    if (!credential) {
      throw new TavilyAuthError('Brave API key is missing from keychain.', {
        provider: this.name,
        code: 'missing-api-key',
      });
    }

    const url = new URL(this.endpoint);
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(Math.max(1, opts.limit)));

    const response = await this.requestFn(url.toString(), {
      method: 'GET',
      signal: opts.signal,
      headers: {
        accept: 'application/json',
        'x-subscription-token': credential.value,
      },
    });

    const host = url.host;
    if (response.statusCode === 401 || response.statusCode === 403) {
      throw new TavilyAuthError('Brave rejected the request credentials.', {
        provider: this.name,
        statusCode: response.statusCode,
        host,
      });
    }

    if (response.statusCode === 429) {
      throw new RateLimitError('Brave rate limit exceeded.', {
        provider: this.name,
        statusCode: response.statusCode,
        host,
        retryAfter: firstHeader(response.headers['retry-after']),
      });
    }

    if (response.statusCode >= 400) {
      throw new SearchProviderError(`Brave request failed with HTTP ${response.statusCode}.`, {
        provider: this.name,
        statusCode: response.statusCode,
        host,
      });
    }

    let payload: BraveResponseWire;
    try {
      payload = JSON.parse(await response.body.text()) as BraveResponseWire;
    } catch (error) {
      throw new SearchProviderError('Failed to parse Brave response JSON.', {
        provider: this.name,
        host,
        code: `parse-error:${error instanceof Error ? error.message : String(error)}`,
      });
    }

    const rows = payload.web?.results;
    if (!isBraveResults(rows)) {
      throw new SearchProviderError('Brave response is missing web.results[].', {
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
          snippet: typeof row.description === 'string' ? row.description : null,
          source: this.name,
          rank,
          publishedAt: parseAgeToIso(row.age),
        };
      })
      .filter((row): row is SearchResult => row !== null)
      .slice(0, Math.max(1, opts.limit));
  }
}

function parseAgeToIso(age: string | undefined): string | null {
  if (!age) {
    return null;
  }

  const parsed = Date.parse(age);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function isBraveResults(value: unknown): value is readonly BraveResultWire[] {
  return Array.isArray(value);
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
