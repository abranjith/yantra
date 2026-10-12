import { err, ok } from '@yantra/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { Logger } from '../../../src/browser/types.js';
import {
  NoSearchProviderAvailableError,
  RateLimitError,
  ScrapeSearchError,
  SearchCircuitOpenError,
  SearchProviderError,
} from '../../../src/extraction/search/errors.js';
import type { SearchProvider } from '../../../src/extraction/search/registry.js';
import { SEARCH_POLITENESS, SearchService } from '../../../src/extraction/search/search-service.js';
import type { SearchProviderName, SearchResult } from '../../../src/extraction/types.js';

/** A clock that only moves when the service sleeps. */
function fakeClock() {
  let time = 1_000_000;
  const sleeps: number[] = [];
  return {
    now: () => time,
    sleep: (ms: number, signal: AbortSignal) => {
      signal.throwIfAborted();
      sleeps.push(ms);
      time += ms;
      return Promise.resolve();
    },
    sleeps,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

function recordingLogger(): Logger & { readonly warns: unknown[] } {
  const warns: unknown[] = [];
  return {
    warns,
    info: () => undefined,
    warn: (obj) => warns.push(obj),
    error: () => undefined,
    debug: () => undefined,
  };
}

const HITS: readonly SearchResult[] = [
  {
    url: 'https://a.example/',
    title: 'A',
    snippet: null,
    source: 'duckduckgo',
    rank: 1,
    publishedAt: null,
  },
];

/** A controllable provider: each call is held until released, or fails as scripted. */
function scriptedProvider(
  name: SearchProviderName,
  clock: { now: () => number },
  fail?: (call: number) => Error | null,
) {
  const starts: number[] = [];
  const releases: (() => void)[] = [];
  let inFlight = 0;
  let peak = 0;
  const provider: SearchProvider = {
    name,
    search: async () => {
      starts.push(clock.now());
      const error = fail?.(starts.length) ?? null;
      if (error !== null) throw error;
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((resolve) => releases.push(resolve));
      inFlight -= 1;
      return HITS;
    },
  };
  return {
    provider,
    starts,
    calls: () => starts.length,
    peak: () => peak,
    releaseAll: () => {
      for (const release of releases.splice(0)) release();
    },
  };
}

function service(provider: SearchProvider, clock = fakeClock(), logger = recordingLogger()) {
  const resolve = vi.fn(() => Promise.resolve(ok(provider)));
  return {
    resolve,
    logger,
    clock,
    service: new SearchService({ resolve, logger, now: clock.now, sleep: clock.sleep }),
  };
}

const SEARCH = { limit: 5, signal: new AbortController().signal } as const;

/** Let pending promise chains run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

async function facadeOf(target: SearchService): Promise<SearchProvider> {
  const resolved = await target.resolve();
  if (!resolved.isOk) throw resolved.error;
  return resolved.value;
}

describe('@no-llm extraction/search/search-service politeness', () => {
  it('serializes a scraped provider: peak 1, the second search starting ≥ 2000 ms after the first', async () => {
    const clock = fakeClock();
    const scripted = scriptedProvider('duckduckgo', clock);
    const { service: svc } = service(scripted.provider, clock);
    const facade = await facadeOf(svc);

    const first = facade.search('a', SEARCH);
    const second = facade.search('b', SEARCH);
    await flush();
    expect(scripted.calls()).toBe(1);
    scripted.releaseAll();
    await first;
    await flush();
    scripted.releaseAll();
    await second;

    expect(scripted.peak()).toBe(1);
    expect(scripted.starts[1]! - scripted.starts[0]!).toBeGreaterThanOrEqual(2_000);
    expect(svc.stats()).toMatchObject({ calls: 2, providerCalls: 2, peakConcurrency: 1 });
  });

  it('lets an API provider run two at once, immediately', async () => {
    const clock = fakeClock();
    const scripted = scriptedProvider('tavily', clock);
    const { service: svc } = service(scripted.provider, clock);
    const facade = await facadeOf(svc);

    const both = [facade.search('a', SEARCH), facade.search('b', SEARCH)];
    await flush();
    expect(scripted.calls()).toBe(2);
    scripted.releaseAll();
    await Promise.all(both);

    expect(scripted.starts[0]).toBe(scripted.starts[1]);
    expect(clock.sleeps).toEqual([]);
    expect(svc.stats().peakConcurrency).toBe(2);
  });

  it('does not sleep when the interval has already passed', async () => {
    const clock = fakeClock();
    const scripted = scriptedProvider('duckduckgo', clock);
    const { service: svc } = service(scripted.provider, clock);
    const facade = await facadeOf(svc);

    const first = facade.search('a', SEARCH);
    await flush();
    scripted.releaseAll();
    await first;
    clock.advance(5_000);
    const second = facade.search('b', SEARCH);
    await flush();
    scripted.releaseAll();
    await second;

    expect(clock.sleeps).toEqual([]);
  });

  it('a queued search whose signal aborts makes no provider call', async () => {
    const clock = fakeClock();
    const scripted = scriptedProvider('duckduckgo', clock);
    const { service: svc } = service(scripted.provider, clock);
    const facade = await facadeOf(svc);
    const controller = new AbortController();

    const first = facade.search('a', SEARCH);
    const queued = facade.search('b', { limit: 5, signal: controller.signal });
    await flush();
    const reason = new Error('cancelled');
    controller.abort(reason);

    await expect(queued).rejects.toBe(reason);
    scripted.releaseAll();
    await first;
    expect(scripted.calls()).toBe(1);
  });

  it('pins the politeness table: scraped one at a time 2 s apart; API two at once', () => {
    expect(SEARCH_POLITENESS).toEqual({
      scrape: { maxConcurrent: 1, minIntervalMs: 2_000 },
      api: { maxConcurrent: 2, minIntervalMs: 0 },
    });
  });
});

describe('@no-llm extraction/search/search-service breaker', () => {
  const challenge = () =>
    new ScrapeSearchError('challenge', { provider: 'duckduckgo', code: 'anomaly-challenge' });

  it('opens on a challenge: later searches refuse with no provider call', async () => {
    const clock = fakeClock();
    const scripted = scriptedProvider('duckduckgo', clock, (call) =>
      call === 1 ? challenge() : null,
    );
    const { service: svc, logger } = service(scripted.provider, clock);
    const facade = await facadeOf(svc);

    const first = await facade.search('a', SEARCH).catch((e: unknown) => e);
    const second = await facade.search('b', SEARCH).catch((e: unknown) => e);
    const third = await facade.search('c', SEARCH).catch((e: unknown) => e);

    // The first call keeps its true cause; the rest are circuit-open.
    expect(first).toBeInstanceOf(ScrapeSearchError);
    expect(second).toBeInstanceOf(SearchCircuitOpenError);
    expect(third).toBeInstanceOf(SearchCircuitOpenError);
    expect((second as SearchCircuitOpenError).context.code).toBe('circuit-open');
    expect((second as SearchCircuitOpenError).openedBy).toBe('anomaly-challenge');
    expect(scripted.calls()).toBe(1);
    expect(svc.stats()).toEqual({
      calls: 3,
      providerCalls: 1,
      challenges: 1,
      breakerSkipped: 2,
      peakConcurrency: 1,
    });
    expect(svc.breaker()).toMatchObject({ open: true, openedBy: 'anomaly-challenge', skipped: 2 });
    expect(logger.warns).toEqual([
      {
        schema_version: 1,
        event: 'search_breaker_open',
        provider: 'duckduckgo',
        cause: 'anomaly-challenge',
      },
    ]);
  });

  it('opens on a rate limit too', async () => {
    const clock = fakeClock();
    const scripted = scriptedProvider(
      'brave',
      clock,
      () => new RateLimitError('429', { provider: 'brave', statusCode: 429 }),
    );
    const { service: svc } = service(scripted.provider, clock);
    const facade = await facadeOf(svc);

    await facade.search('a', SEARCH).catch(() => undefined);
    const second = await facade.search('b', SEARCH).catch((e: unknown) => e);

    expect((second as SearchCircuitOpenError).openedBy).toBe('rate-limited');
    expect(scripted.calls()).toBe(1);
  });

  it('refuses a search that was queued when the breaker opened', async () => {
    const clock = fakeClock();
    let call = 0;
    let rejectFirst: (error: Error) => void = () => undefined;
    const provider: SearchProvider = {
      name: 'duckduckgo',
      search: () => {
        call += 1;
        return new Promise((_resolve, reject) => {
          rejectFirst = reject;
        });
      },
    };
    const { service: svc } = service(provider, clock);
    const facade = await facadeOf(svc);

    const first = facade.search('a', SEARCH).catch((e: unknown) => e);
    const queued = facade.search('b', SEARCH).catch((e: unknown) => e);
    await flush();
    rejectFirst(challenge());

    expect(await first).toBeInstanceOf(ScrapeSearchError);
    expect(await queued).toBeInstanceOf(SearchCircuitOpenError);
    expect(call).toBe(1);
  });

  it.each([
    [
      'empty results',
      new ScrapeSearchError('none', { provider: 'duckduckgo', code: 'empty-results' }),
    ],
    ['a timeout', new ScrapeSearchError('slow', { provider: 'duckduckgo', code: 'timeout' })],
    ['a server error', new SearchProviderError('5xx', { provider: 'duckduckgo', statusCode: 503 })],
    ['an unexpected error', new TypeError('boom')],
  ])('never opens on %s', async (_label, failure) => {
    const clock = fakeClock();
    const scripted = scriptedProvider('duckduckgo', clock, (call) => (call === 1 ? failure : null));
    const { service: svc } = service(scripted.provider, clock);
    const facade = await facadeOf(svc);

    await expect(facade.search('a', SEARCH)).rejects.toBe(failure);
    const second = facade.search('b', SEARCH);
    await flush();
    scripted.releaseAll();

    await expect(second).resolves.toEqual(HITS);
    expect(svc.breaker().open).toBe(false);
  });
});

describe('@no-llm extraction/search/search-service resolution', () => {
  it('resolves once across three calls and keeps the provider name', async () => {
    const clock = fakeClock();
    const scripted = scriptedProvider('duckduckgo', clock);
    const { service: svc, resolve } = service(scripted.provider, clock);

    const results = await Promise.all([svc.resolve(), svc.resolve(), svc.resolve()]);

    expect(resolve).toHaveBeenCalledTimes(1);
    for (const result of results) {
      expect(result.isOk && result.value.name).toBe('duckduckgo');
    }
  });

  it('memoizes a failed resolution', async () => {
    const failure = new NoSearchProviderAvailableError(['tavily']);
    const resolve = vi.fn(() => Promise.resolve(err(failure)));
    const svc = new SearchService({ resolve, logger: recordingLogger() });

    const first = await svc.resolve();
    const second = await svc.resolve();

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(!first.isOk && first.error).toBe(failure);
    expect(!second.isOk && second.error).toBe(failure);
  });
});
