import {
  BrowserLaunchError,
  NoSearchProviderAvailableError,
  RateLimitError,
  ScrapeSearchError,
  SearchProviderError,
  SearchProviderKeyMissingError,
  TavilyAuthError,
  UnknownSearchProviderError,
} from '@yantra/core';
import { describe, expect, it } from 'vitest';

import {
  isSearchFailureCause,
  mapSearchError,
  SEARCH_FAILURE_CAUSES,
} from '../../../../src/adapters/pi/tools/search-errors.js';
import { AGENT_INTERACTION_MESSAGES } from '../../../../src/runtime/messages.js';
import { COMMAND_TASK_PROFILES } from '../../../../src/runtime/profiles.js';

const CANARY = 'CANARY-7f3a-detail-text';

interface Row {
  readonly name: string;
  readonly error: unknown;
  readonly code: string;
  readonly retryable: boolean;
  readonly cause: string;
  readonly provider: string;
}

/** Every row of the spec table, built from the real exported classes. */
const ROWS: readonly Row[] = [
  {
    name: 'scrape anomaly challenge',
    error: new ScrapeSearchError('challenge', {
      provider: 'duckduckgo',
      code: 'anomaly-challenge',
    }),
    code: 'SEARCH_BLOCKED',
    retryable: false,
    cause: 'anomaly-challenge',
    provider: 'duckduckgo',
  },
  {
    name: 'HTTP 429',
    error: new RateLimitError('rate', { provider: 'brave', statusCode: 429 }),
    code: 'SEARCH_BLOCKED',
    retryable: false,
    cause: 'rate-limited',
    provider: 'brave',
  },
  {
    name: 'empty results',
    error: new ScrapeSearchError('empty', { provider: 'duckduckgo', code: 'empty-results' }),
    code: 'SEARCH_NO_RESULTS',
    retryable: true,
    cause: 'empty-results',
    provider: 'duckduckgo',
  },
  {
    name: 'SERP navigation timeout',
    error: new ScrapeSearchError('slow', { provider: 'google', code: 'TimeoutError' }),
    code: 'SEARCH_TIMEOUT',
    retryable: true,
    cause: 'timeout',
    provider: 'google',
  },
  {
    name: 'keyed provider timeout code',
    error: new SearchProviderError('slow', { provider: 'tavily', code: 'request-timeout' }),
    code: 'SEARCH_TIMEOUT',
    retryable: true,
    cause: 'timeout',
    provider: 'tavily',
  },
  {
    name: 'ethics refusal of the SERP',
    error: new ScrapeSearchError('refused', {
      provider: 'duckduckgo',
      code: `ethics-refused:robots:${CANARY}`,
    }),
    code: 'SEARCH_PROVIDER_UNAVAILABLE',
    retryable: false,
    cause: 'ethics-refused:robots',
    provider: 'duckduckgo',
  },
  {
    name: 'key missing at resolution',
    error: new SearchProviderKeyMissingError('tavily', 'tavily-api-key'),
    code: 'SEARCH_PROVIDER_UNAVAILABLE',
    retryable: false,
    cause: 'key-missing',
    provider: 'tavily',
  },
  {
    name: 'key missing at search time',
    error: new TavilyAuthError('missing', { provider: 'brave', code: 'missing-api-key' }),
    code: 'SEARCH_PROVIDER_UNAVAILABLE',
    retryable: false,
    cause: 'key-missing',
    provider: 'brave',
  },
  {
    name: 'no provider available',
    error: new NoSearchProviderAvailableError(['tavily', 'brave']),
    code: 'SEARCH_PROVIDER_UNAVAILABLE',
    retryable: false,
    cause: 'no-provider-available',
    provider: 'brave',
  },
  {
    name: 'unknown provider',
    error: new UnknownSearchProviderError('bing'),
    code: 'SEARCH_PROVIDER_UNAVAILABLE',
    retryable: false,
    cause: 'unknown-provider',
    provider: 'duckduckgo',
  },
  {
    name: 'credentials rejected',
    error: new TavilyAuthError('rejected', { provider: 'tavily', statusCode: 401 }),
    code: 'SEARCH_PROVIDER_UNAVAILABLE',
    retryable: false,
    cause: 'auth-rejected',
    provider: 'tavily',
  },
  {
    name: 'provider 5xx',
    error: new SearchProviderError('down', { provider: 'brave', statusCode: 503 }),
    code: 'SEARCH_PROVIDER_UNAVAILABLE',
    retryable: true,
    cause: 'http-5xx',
    provider: 'brave',
  },
  {
    name: 'provider 4xx',
    error: new SearchProviderError('bad', { provider: 'brave', statusCode: 400 }),
    code: 'SEARCH_FAILED',
    retryable: false,
    cause: 'http-4xx',
    provider: 'brave',
  },
  {
    name: 'unparseable response',
    error: new SearchProviderError('parse', { provider: 'tavily', code: `parse-error:${CANARY}` }),
    code: 'SEARCH_FAILED',
    retryable: false,
    cause: 'invalid-response',
    provider: 'tavily',
  },
  {
    name: 'invalid response shape',
    error: new SearchProviderError('shape', { provider: 'tavily', code: 'invalid-shape' }),
    code: 'SEARCH_FAILED',
    retryable: false,
    cause: 'invalid-response',
    provider: 'tavily',
  },
  {
    name: 'SERP navigation failure',
    error: new ScrapeSearchError('nav', { provider: 'duckduckgo', code: 'ProtocolError' }),
    code: 'SEARCH_FAILED',
    retryable: true,
    cause: 'serp-fetch-failed',
    provider: 'duckduckgo',
  },
  {
    name: 'aborted SERP fetch',
    error: new ScrapeSearchError('aborted', { provider: 'duckduckgo', code: 'aborted' }),
    code: 'SEARCH_FAILED',
    retryable: false,
    cause: 'aborted',
    provider: 'duckduckgo',
  },
  {
    name: 'unknown error',
    error: new TypeError(`boom ${CANARY}`),
    code: 'SEARCH_FAILED',
    retryable: false,
    cause: 'unexpected:TypeError',
    provider: 'duckduckgo',
  },
];

describe('@no-llm web_search error mapper', () => {
  it.each(ROWS)('maps $name to $code ($cause)', (row) => {
    const failure = mapSearchError(row.error, row.provider);

    expect(failure.ok).toBe(false);
    expect(failure.errorCode).toBe(row.code);
    expect(failure.retryable).toBe(row.retryable);
    expect(failure.diagnostic).toEqual({ cause: row.cause, provider: row.provider });
    expect(isSearchFailureCause(row.cause)).toBe(true);
    // The wording agrees with the flag: a retryable cause invites one retry,
    // a non-retryable one says not to.
    expect(failure.message).toMatch(row.retryable ? /retry|search again/i : /do not|will fail/i);
  });

  it('renders pairwise-distinct messages across every cause', () => {
    // Rows sharing a cause (two timeouts, two key-missing, two invalid-response)
    // share wording by design; with the provider held fixed, every distinct
    // cause must read differently from every other.
    const byCause = new Map<string, string>();
    for (const row of ROWS) {
      const cause = row.cause.startsWith('unexpected:') ? 'unexpected' : row.cause;
      byCause.set(cause, mapSearchError(row.error, 'duckduckgo').message);
    }

    expect(new Set(byCause.values()).size).toBe(byCause.size);
  });

  it('names the provider in every provider-specific message', () => {
    const failure = mapSearchError(ROWS[0]!.error, 'duckduckgo');

    expect(failure.message).toMatch(/^duckduckgo served an anti-bot challenge/);
    expect(failure.message).toContain('web_fetch');
    expect(failure.message).toContain('result_publish');
  });

  it('never surfaces raw provider text from a parse-error or ethics detail code', () => {
    for (const row of ROWS) {
      const failure = mapSearchError(row.error, row.provider);
      const surfaced = JSON.stringify({
        message: failure.message,
        details: failure.details,
        diagnostic: failure.diagnostic,
      });
      expect(surfaced).not.toContain(CANARY);
    }
  });

  it('maps a SERP browser that will not start to the FEAT-047 browser code', () => {
    const error = new BrowserLaunchError({ phase: 'connect', lastStderr: CANARY, args: [] });

    const failure = mapSearchError(error, 'duckduckgo');

    expect(failure.errorCode).toBe('BROWSER_LAUNCH_FAILED');
    expect(failure.retryable).toBe(false);
    expect(failure.diagnostic).toEqual({ cause: 'browser-startup', provider: 'duckduckgo' });
    expect(JSON.stringify(failure)).not.toContain(CANARY);
  });

  it('falls back to the error-carried provider when resolution failed', () => {
    const failure = mapSearchError(
      new SearchProviderKeyMissingError('brave', 'brave-api-key'),
      null,
    );

    expect(failure.diagnostic?.provider).toBe('brave');
    expect(failure.message).toMatch(/^brave needs an API key/);
  });

  it('omits the provider diagnostic when nothing names one', () => {
    const failure = mapSearchError(new Error('x'), null);

    expect(failure.errorCode).toBe('SEARCH_FAILED');
    expect(failure.diagnostic).toEqual({ cause: 'unexpected:Error' });
    expect(failure.message).toContain('the search provider');
  });

  it('normalizes an unknown ethics reason instead of copying it', () => {
    const failure = mapSearchError(
      new ScrapeSearchError('x', { provider: 'google', code: `ethics-refused:${CANARY}:more` }),
      'google',
    );

    expect(failure.diagnostic?.cause).toBe('ethics-refused:blocklist');
    expect(JSON.stringify(failure)).not.toContain(CANARY);
  });

  it('sanitizes a non-identifier error class name', () => {
    const odd = new Error('x');
    odd.name = 'Weird name with spaces';

    expect(mapSearchError(odd, 'google').diagnostic?.cause).toBe('unexpected:Error');
    expect(mapSearchError('not an error', 'google').diagnostic?.cause).toBe('unexpected:NonError');
  });

  it('declares a closed cause vocabulary and rejects anything else', () => {
    expect(SEARCH_FAILURE_CAUSES.length).toBeGreaterThan(0);
    expect(isSearchFailureCause('ethics-refused:robots')).toBe(true);
    expect(isSearchFailureCause('ethics-refused:other')).toBe(false);
    expect(isSearchFailureCause('ethics-refused:<reason>')).toBe(false);
    expect(isSearchFailureCause('parse-error:boom')).toBe(false);
    expect(isSearchFailureCause('unexpected:has space')).toBe(false);
  });

  it('declares, for every SEARCH_* template, a capability every web_search profile registers', () => {
    const templates = AGENT_INTERACTION_MESSAGES.filter((entry) =>
      entry.code.startsWith('SEARCH_'),
    );
    expect(templates.length).toBeGreaterThan(0);
    for (const profile of Object.values(COMMAND_TASK_PROFILES)) {
      const names = profile.toolNames as readonly string[];
      if (!names.includes('web_search')) continue;
      for (const template of templates) {
        expect(template.capability).not.toBeNull();
        expect(names).toContain(template.capability);
      }
    }
  });
});
