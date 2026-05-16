import {
  Agent,
  MockAgent,
  getGlobalDispatcher,
  setGlobalDispatcher,
  type Dispatcher,
} from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RateLimitError, SearchProviderError, TavilyAuthError } from '../../../src/extraction/search/errors.js';
import { TavilySearchProvider } from '../../../src/extraction/search/tavily.js';
import type { KeychainProvider } from '../../../src/secrets/keychain.js';

function keychainWith(entries: Record<string, string>): KeychainProvider {
  return {
    get: async (_service, account) => entries[account] ?? null,
    set: async () => undefined,
    delete: async () => false,
    list: async () => [],
    isAvailable: async () => true,
  };
}

describe('@no-llm extraction/search/tavily', () => {
  let mockAgent: MockAgent;
  let previousDispatcher: Dispatcher;

  beforeEach(() => {
    previousDispatcher = getGlobalDispatcher();
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
  });

  afterEach(async () => {
    setGlobalDispatcher(previousDispatcher ?? new Agent());
    await mockAgent.close();
  });

  it('maps a successful response into SearchResult rows', async () => {
    mockAgent
      .get('https://api.tavily.com')
      .intercept({ path: '/search', method: 'POST' })
      .reply(200, {
        results: [
          {
            url: 'https://example.com/one',
            title: 'One',
            content: 'Snippet one',
            published_date: '2026-05-11T10:14:00.000Z',
          },
          {
            url: 'https://example.com/two',
            title: 'Two',
            content: 'Snippet two',
          },
        ],
      });

    const provider = new TavilySearchProvider({ keychain: keychainWith({ 'tavily.api_key': 'k' }) });
    const rows = await provider.search('ai news', { limit: 3, signal: new AbortController().signal });

    expect(rows).toHaveLength(2);
    expect(rows[0]?.source).toBe('tavily');
    expect(rows[0]?.rank).toBe(0);
  });

  it('throws TavilyAuthError for 401/403 responses', async () => {
    mockAgent
      .get('https://api.tavily.com')
      .intercept({ path: '/search', method: 'POST' })
      .reply(401, { error: 'unauthorized' });

    const provider = new TavilySearchProvider({ keychain: keychainWith({ 'tavily.api_key': 'k' }) });

    await expect(
      provider.search('ai news', { limit: 3, signal: new AbortController().signal }),
    ).rejects.toBeInstanceOf(TavilyAuthError);
  });

  it('throws RateLimitError for HTTP 429', async () => {
    mockAgent
      .get('https://api.tavily.com')
      .intercept({ path: '/search', method: 'POST' })
      .reply(429, { error: 'rate_limited' });

    const provider = new TavilySearchProvider({ keychain: keychainWith({ 'tavily.api_key': 'k' }) });

    await expect(
      provider.search('ai news', { limit: 3, signal: new AbortController().signal }),
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it('throws SearchProviderError when response is malformed', async () => {
    mockAgent
      .get('https://api.tavily.com')
      .intercept({ path: '/search', method: 'POST' })
      .reply(200, '{not-json');

    const provider = new TavilySearchProvider({ keychain: keychainWith({ 'tavily.api_key': 'k' }) });

    await expect(
      provider.search('ai news', { limit: 3, signal: new AbortController().signal }),
    ).rejects.toBeInstanceOf(SearchProviderError);
  });
});
