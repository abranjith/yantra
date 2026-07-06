import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  Agent,
  MockAgent,
  getGlobalDispatcher,
  setGlobalDispatcher,
  type Dispatcher,
} from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SearchProviderError } from '../../../src/extraction/search/errors.js';
import {
  SEARCH_PROVIDER_NAMES,
  SEARCH_PROVIDER_REGISTRY,
  type SearchProvider,
  type SearchProviderDeps,
} from '../../../src/extraction/search/registry.js';
import type { SearchEthicsGate } from '../../../src/extraction/search/scrape-transport.js';
import type { SearchProviderName, SearchResult } from '../../../src/extraction/types.js';

import {
  fakeBrowserProvider,
  keychainWith,
  passGate,
  refuseGate,
  silentLogger,
} from './helpers.js';

/**
 * The recorded fixture each provider is exercised against. Every registered
 * descriptor MUST have an entry here — the completeness test enforces it, so a
 * newly-registered provider without fixtures fails the suite.
 */
const FIXTURE_FILE: Record<SearchProviderName, string> = {
  tavily: 'tavily.json',
  brave: 'brave.json',
  google: 'google-serp.html',
  duckduckgo: 'duckduckgo-serp.html',
};

function readFixture(name: string): string {
  return readFileSync(resolve(import.meta.dirname, 'fixtures', name), 'utf8');
}

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

/** Primes the network mock for an API provider so its search succeeds. */
function primeApiMock(name: SearchProviderName): void {
  const body = readFixture(FIXTURE_FILE[name]);
  if (name === 'tavily') {
    mockAgent
      .get('https://api.tavily.com')
      .intercept({ path: '/search', method: 'POST' })
      .reply(200, body);
  } else if (name === 'brave') {
    mockAgent
      .get('https://api.search.brave.com')
      .intercept({ path: (path) => path.startsWith('/res/v1/web/search'), method: 'GET' })
      .reply(200, body);
  }
}

function depsFor(
  name: SearchProviderName,
  opts: { key?: boolean; gate?: SearchEthicsGate } = {},
): SearchProviderDeps {
  const descriptor = SEARCH_PROVIDER_REGISTRY[name];
  const keychain =
    descriptor.requiresKey && opts.key !== false
      ? keychainWith({ [descriptor.requiresKey]: 'k' })
      : keychainWith({});
  const html = descriptor.kind === 'scrape' ? readFixture(FIXTURE_FILE[name]) : '<html></html>';

  return {
    keychain,
    browserProvider: fakeBrowserProvider(html).provider,
    ethicsGate: opts.gate ?? passGate,
    logger: silentLogger,
  };
}

/** Builds a provider primed to return successful results. */
function buildSuccess(name: SearchProviderName): SearchProvider {
  const descriptor = SEARCH_PROVIDER_REGISTRY[name];
  if (descriptor.kind === 'api') {
    primeApiMock(name);
  }
  return descriptor.create(depsFor(name, { key: true }));
}

function assertResultShape(row: SearchResult, name: SearchProviderName): void {
  expect(typeof row.url).toBe('string');
  expect(row.url.length).toBeGreaterThan(0);
  expect(row.title === null || typeof row.title === 'string').toBe(true);
  expect(row.snippet === null || typeof row.snippet === 'string').toBe(true);
  expect(row.source).toBe(name);
  expect(typeof row.rank).toBe('number');
  expect(row.publishedAt === null || typeof row.publishedAt === 'string').toBe(true);
}

describe('@no-llm extraction/search/contract', () => {
  it('has a fixture registered for every provider in the registry', () => {
    for (const name of SEARCH_PROVIDER_NAMES) {
      const file = FIXTURE_FILE[name];
      // Every registered provider must declare a fixture that exists on disk;
      // a newly-registered provider without one fails here.
      expect(file).toBeTruthy();
      expect(existsSync(resolve(import.meta.dirname, 'fixtures', file))).toBe(true);
    }
  });

  // Every registered descriptor is automatically placed under contract. A future
  // provider added to the registry is exercised here with no extra wiring.
  describe.each(SEARCH_PROVIDER_NAMES.map((name) => [name] as const))('provider "%s"', (name) => {
    it('returns results with a valid shape', async () => {
      const provider = buildSuccess(name);
      const rows = await provider.search('ai news', {
        limit: 3,
        signal: new AbortController().signal,
      });

      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        assertResultShape(row, name);
      }
    });

    it('emits ranks in ascending order starting at 0', async () => {
      const provider = buildSuccess(name);
      const rows = await provider.search('ai news', {
        limit: 3,
        signal: new AbortController().signal,
      });

      const ranks = rows.map((r) => r.rank);
      expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
      expect(ranks[0]).toBe(0);
    });

    it('respects the requested limit', async () => {
      const provider = buildSuccess(name);
      const rows = await provider.search('ai news', {
        limit: 2,
        signal: new AbortController().signal,
      });

      expect(rows.length).toBeLessThanOrEqual(2);
    });

    it('honors a pre-aborted signal by rejecting', async () => {
      const provider = buildSuccess(name);
      const controller = new AbortController();
      controller.abort();

      await expect(
        provider.search('ai news', { limit: 3, signal: controller.signal }),
      ).rejects.toThrow();
    });

    it('surfaces failures as typed SearchProviderError subclasses', async () => {
      const descriptor = SEARCH_PROVIDER_REGISTRY[name];
      let provider: SearchProvider;
      if (descriptor.kind === 'api') {
        // Missing key → typed auth error, no network needed.
        provider = descriptor.create(depsFor(name, { key: false }));
      } else {
        // Ethics refusal → typed scrape error.
        provider = descriptor.create(depsFor(name, { gate: refuseGate('robots', 'disallowed') }));
      }

      const error = await provider
        .search('ai news', { limit: 3, signal: new AbortController().signal })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(SearchProviderError);
    });
  });
});
