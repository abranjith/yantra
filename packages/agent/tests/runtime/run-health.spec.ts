import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ReadabilityExtractor,
  type BrowserProvider,
  type BrowserSession,
  type ChromeInstall,
} from '@yantra/core';
import { BriefNotice, RunHealth } from '@yantra/protocol';
import { assertRuntimeEventIsSafe } from '@yantra/test-helpers';
import { describe, expect, it, vi } from 'vitest';

import { webFetchSpec } from '../../src/adapters/pi/tools/web-fetch.js';
import { wrapTool } from '../../src/runtime/middleware.js';
import {
  countingBrowserProvider,
  MAX_RUNTIME_NOTICES,
  RunHealthLedger,
} from '../../src/runtime/run-health.js';
import { UrlProvenance } from '../../src/runtime/url-provenance.js';
import { articleHtml, listingHtml } from '../adapters/pi/tools/page-fixtures.js';
import { buildServices, fetchedDoc } from '../adapters/pi/tools/test-support.js';

describe('@no-llm RunHealthLedger — recording', () => {
  it('keeps tool outcomes in completion order', () => {
    const ledger = new RunHealthLedger();

    ledger.recordToolOutcome({ tool: 'web_search', status: 'ok', provider: 'duckduckgo' });
    ledger.recordToolOutcome({
      tool: 'web_search',
      status: 'error',
      code: 'SEARCH_BLOCKED',
      cause: 'anomaly-challenge',
      provider: 'duckduckgo',
    });
    ledger.recordToolOutcome({ tool: 'web_fetch', status: 'timeout', code: 'TOOL_TIMEOUT' });

    expect(ledger.toolOutcomes().map((o) => `${o.tool}:${o.status}`)).toEqual([
      'web_search:ok',
      'web_search:error',
      'web_fetch:timeout',
    ]);
  });

  it('collects distinct search providers in first-use order, from web_search only', () => {
    const ledger = new RunHealthLedger();

    ledger.recordToolOutcome({ tool: 'web_search', status: 'error', provider: 'duckduckgo' });
    ledger.recordToolOutcome({ tool: 'web_fetch', status: 'ok', provider: 'ignored' });
    ledger.recordToolOutcome({ tool: 'web_search', status: 'ok', provider: 'tavily' });
    ledger.recordToolOutcome({ tool: 'web_search', status: 'ok', provider: 'duckduckgo' });

    expect(ledger.searchProviders()).toEqual(['duckduckgo', 'tavily']);
  });

  it('keeps the first tool and sums skipped reads per exhausted limit', () => {
    const ledger = new RunHealthLedger();

    ledger.recordBudgetExhaustion('navigations', 'web_search', 2);
    ledger.recordBudgetExhaustion('navigations', 'web_fetch', 1);
    ledger.recordBudgetExhaustion('hosts', 'web_fetch', -3);

    expect([...ledger.budgetExhaustions()]).toEqual([
      ['navigations', { firstTool: 'web_search', skippedReads: 3 }],
      ['hosts', { firstTool: 'web_fetch', skippedReads: 0 }],
    ]);
  });

  it('counts repeat fetches by normalized URL', () => {
    const ledger = new RunHealthLedger();

    ledger.recordFetch('https://Cars.Example/a#top', 'http');
    ledger.recordFetch('https://cars.example:443/a', 'browser');
    ledger.recordFetch('https://cars.example/b', 'http');
    ledger.recordFetch('https://cars.example/a?page=2', 'http');
    ledger.recordFetch('https://cars.example/a', 'http');

    expect(ledger.fetches()).toHaveLength(5);
    expect(ledger.repeatFetches()).toBe(2);
  });

  it('counts browser launches and source failures', () => {
    const ledger = new RunHealthLedger();

    ledger.recordBrowserLaunch();
    ledger.recordBrowserLaunch();
    ledger.recordSourceFailure({
      tool: 'web_search',
      host: 'a.example',
      stage: 'fetch',
      reason: 'timeout',
    });

    expect(ledger.browserLaunches()).toBe(2);
    expect(ledger.sourceFailures()).toEqual([
      { tool: 'web_search', host: 'a.example', stage: 'fetch', reason: 'timeout' },
    ]);
  });

  it('returns defensive copies', () => {
    const ledger = new RunHealthLedger();
    ledger.recordToolOutcome({ tool: 'x', status: 'ok' });

    (ledger.toolOutcomes() as unknown[]).length = 0;

    expect(ledger.toolOutcomes()).toHaveLength(1);
  });
});

describe('@no-llm RunHealthLedger — store-answered reads (FEAT-050)', () => {
  it('counts repeats by the canonical page identity the document store uses', () => {
    const ledger = new RunHealthLedger();

    // Tracking parameters and a trailing slash name the same page.
    ledger.recordFetch('https://cars.example/a/?utm_source=x', 'http');
    ledger.recordFetch('https://cars.example/a', 'http');

    expect(ledger.repeatFetches()).toBe(1);
  });

  it('counts cache and memo hits separately from network fetches', () => {
    const ledger = new RunHealthLedger();

    ledger.recordFetch('https://cars.example/a', 'http');
    ledger.recordCacheHit();
    ledger.recordCacheHit();
    ledger.recordMemoHit();

    expect(ledger.fetches()).toHaveLength(1);
    expect(ledger.cacheHitCount()).toBe(2);
    expect(ledger.memoHitCount()).toBe(1);
    const summary = ledger.summary({
      runId: 'r',
      snapshot: { navigations: 1, hosts: 1 },
      limits: { maxNavigations: 30, maxHosts: 20 },
      noticeCount: 0,
    });
    expect(summary.fetches).toMatchObject({ total: 1, cache_hits: 2, memo_hits: 1 });
    expect(RunHealth.safeParse(summary).success).toBe(true);
  });

  it('does not count a memo replay as another failed page read in notices', () => {
    const ledger = new RunHealthLedger();
    const failure = {
      tool: 'web_fetch',
      status: 'error' as const,
      code: 'FETCH_HTTP_ERROR',
      host: 'cars.example',
    };

    ledger.recordToolOutcome({ ...failure, cause: 'http-4xx' });
    ledger.recordToolOutcome({ ...failure, cause: 'already-attempted' });

    expect(ledger.briefFacts().notices).toEqual([
      {
        kind: 'fetch_failed',
        source: 'cars.example',
        reason: '1 page read on cars.example failed: the server returned an HTTP error.',
      },
    ]);
  });
});

describe('@no-llm RunHealthLedger — runtime-derived Brief facts', () => {
  /** The G4/G6 shape from run 20260925T130634Z. */
  function g4g6Ledger(): RunHealthLedger {
    const ledger = new RunHealthLedger({ maxNavigations: 30, maxHosts: 20 });
    const search = (status: 'ok' | 'error', code?: string, cause?: string) =>
      ledger.recordToolOutcome({
        tool: 'web_search',
        status,
        provider: 'duckduckgo',
        ...(code === undefined ? {} : { code }),
        ...(cause === undefined ? {} : { cause }),
      });
    for (let i = 0; i < 11; i += 1) search('ok');
    for (let i = 0; i < 9; i += 1) search('error', 'SEARCH_BLOCKED', 'anomaly-challenge');
    for (let i = 0; i < 2; i += 1) search('error', 'SEARCH_NO_RESULTS', 'empty-results');
    ledger.recordBudgetExhaustion('navigations', 'web_search', 4);
    for (const host of ['cars.example', 'cars.example', 'dealer.example', 'dealer.example']) {
      ledger.recordSourceFailure({
        tool: 'web_search',
        host,
        stage: 'fetch',
        reason: 'fetch timed out',
      });
    }
    return ledger;
  }

  it('derives the expected notices, in order, from the G4/G6 fault mix', () => {
    const facts = g4g6Ledger().briefFacts();

    expect(facts.searchProvider).toBe('duckduckgo');
    expect(facts.notices).toEqual([
      {
        kind: 'search_failed',
        source: 'search:duckduckgo',
        reason:
          '9 of 22 web searches failed: the provider served an anti-bot challenge (SEARCH_BLOCKED).',
      },
      {
        kind: 'search_failed',
        source: 'search:duckduckgo',
        reason:
          '2 of 22 web searches failed: the provider returned no results (SEARCH_NO_RESULTS).',
      },
      {
        kind: 'budget_exhausted',
        source: 'runtime',
        reason:
          "Yantra's navigation budget (30) was exhausted; 4 further page reads were not attempted.",
      },
      {
        kind: 'fetch_failed',
        source: 'cars.example',
        reason: '2 page reads on cars.example failed: fetch timed out.',
      },
      {
        kind: 'fetch_failed',
        source: 'dealer.example',
        reason: '2 page reads on dealer.example failed: fetch timed out.',
      },
    ]);
  });

  it('every derived notice is schema-valid', () => {
    for (const notice of g4g6Ledger().briefFacts().notices) {
      expect(BriefNotice.safeParse(notice).success).toBe(true);
    }
  });

  it('a run with no faults has no notices and a null provider when no search ran', () => {
    const ledger = new RunHealthLedger();
    ledger.recordToolOutcome({ tool: 'web_fetch', status: 'ok', host: 'a.example' });

    expect(ledger.briefFacts()).toEqual({ notices: [], searchProvider: null });
  });

  it('counts TOOL_TIMEOUT on web_search as a search failure, ignoring never-attempted calls', () => {
    const ledger = new RunHealthLedger();
    ledger.recordToolOutcome({ tool: 'web_search', status: 'ok', provider: 'tavily' });
    ledger.recordToolOutcome({
      tool: 'web_search',
      status: 'timeout',
      code: 'TOOL_TIMEOUT',
      cause: 'per-tool-timeout',
    });
    ledger.recordToolOutcome({
      tool: 'web_search',
      status: 'error',
      code: 'EVIDENCE_FROZEN',
      cause: 'evidence-frozen',
    });
    ledger.recordToolOutcome({ tool: 'web_search', status: 'aborted', code: 'AGENT_ABORTED' });

    expect(ledger.attemptedSearches()).toHaveLength(2);
    expect(ledger.briefFacts().notices).toEqual([
      {
        kind: 'search_failed',
        source: 'search:tavily',
        reason: '1 of 2 web searches failed: the search exceeded its time budget (TOOL_TIMEOUT).',
      },
    ]);
  });

  it('labels a failure with no known provider plainly and leaves search_provider null', () => {
    const ledger = new RunHealthLedger();
    ledger.recordToolOutcome({
      tool: 'web_search',
      status: 'error',
      code: 'SEARCH_PROVIDER_UNAVAILABLE',
      cause: 'no-provider-available',
    });

    const facts = ledger.briefFacts();

    expect(facts.searchProvider).toBeNull();
    expect(facts.notices).toEqual([
      {
        kind: 'search_failed',
        source: 'search',
        reason:
          '1 of 1 web search failed: no search provider was available (SEARCH_PROVIDER_UNAVAILABLE).',
      },
    ]);
  });

  it('merges web_fetch failures with web_search per-site failures by kind and host', () => {
    const ledger = new RunHealthLedger();
    ledger.recordSourceFailure({
      tool: 'web_search',
      host: 'a.example',
      stage: 'extract',
      reason: 'could not extract a readable article',
    });
    ledger.recordSourceFailure({
      tool: 'web_search',
      host: 'e.example',
      stage: 'policy',
      reason: 'policy - url-policy: too long',
    });
    const fetchFailure = (code: string, cause: string, host: string) =>
      ledger.recordToolOutcome({ tool: 'web_fetch', status: 'error', code, cause, host });
    fetchFailure('EXTRACTION_EMPTY', 'extraction-empty', 'a.example');
    fetchFailure('ETHICS_BLOCKED', 'ethics-refused:robots', 'b.example');
    fetchFailure('URL_INSECURE', 'url-policy:url-insecure', 'c.example');
    fetchFailure('BUDGET_EXHAUSTED', 'budget:navigations', 'd.example');

    expect(ledger.briefFacts().notices).toEqual([
      {
        kind: 'extract_failed',
        source: 'a.example',
        reason:
          '2 page reads on a.example produced no readable content: could not extract a readable article.',
      },
      {
        kind: 'other',
        source: 'e.example',
        reason: "Yantra's URL policy refused 1 page read on e.example.",
      },
      {
        kind: 'blocked',
        source: 'b.example',
        reason: "1 page read on b.example was not made: refused by the site's robots.txt.",
      },
      {
        kind: 'other',
        source: 'c.example',
        reason: "Yantra's URL policy refused 1 page read on c.example.",
      },
    ]);
  });

  it('never copies an unstable per-site reason (which can carry a URL) into a notice', () => {
    const ledger = new RunHealthLedger();
    ledger.recordSourceFailure({
      tool: 'web_search',
      host: 'a.example',
      stage: 'fetch',
      reason: 'connect ECONNREFUSED https://a.example/private?token=SECRET',
    });

    const [notice] = ledger.briefFacts().notices;

    expect(notice?.reason).toBe('1 page read on a.example failed: fetch failed.');
  });

  it('omits the budget ceiling when the ledger was not told it, and names hosts budgets', () => {
    const ledger = new RunHealthLedger();
    ledger.recordBudgetExhaustion('hosts', 'web_fetch', 1);

    expect(ledger.briefFacts().notices).toEqual([
      {
        kind: 'budget_exhausted',
        source: 'runtime',
        reason:
          "Yantra's distinct-host budget was exhausted; 1 further page read was not attempted.",
      },
    ]);
  });

  it('caps notices at ten with one overflow notice pointing at Run Health', () => {
    const ledger = new RunHealthLedger();
    for (let i = 0; i < 14; i += 1) {
      ledger.recordSourceFailure({
        tool: 'web_search',
        host: `h${i}.example`,
        stage: 'fetch',
        reason: 'fetch failed',
      });
    }

    const { notices } = ledger.briefFacts();

    expect(notices).toHaveLength(MAX_RUNTIME_NOTICES);
    expect(notices[9]).toEqual({
      kind: 'other',
      source: 'runtime',
      reason: '5 more run notices are summarized in report.md under Run Health.',
    });
  });

  it('records the published notice count as given', () => {
    const ledger = new RunHealthLedger();

    expect(ledger.publishedNoticeCount()).toBe(0);
    ledger.recordPublishedNotices(3);
    expect(ledger.publishedNoticeCount()).toBe(3);
  });
});

describe('@no-llm RunHealthLedger — summary', () => {
  it('summarizes a seeded ledger with consistent arithmetic', () => {
    const ledger = new RunHealthLedger();
    ledger.recordToolOutcome({ tool: 'web_search', status: 'ok', provider: 'duckduckgo' });
    ledger.recordToolOutcome({
      tool: 'web_search',
      status: 'error',
      code: 'SEARCH_BLOCKED',
      cause: 'anomaly-challenge',
      provider: 'duckduckgo',
    });
    ledger.recordToolOutcome({ tool: 'web_search', status: 'timeout', code: 'TOOL_TIMEOUT' });
    ledger.recordToolOutcome({ tool: 'web_search', status: 'error', code: 'EVIDENCE_FROZEN' });
    ledger.recordToolOutcome({
      tool: 'web_fetch',
      status: 'error',
      code: 'FETCH_TIMEOUT',
      host: 'a.example',
    });
    ledger.recordToolOutcome({
      tool: 'browser_navigate',
      status: 'error',
      code: 'BUDGET_EXHAUSTED',
      budgetLimit: 'wall-clock-soft',
    });
    ledger.recordFetch('https://a.example/1', 'http');
    ledger.recordFetch('https://a.example/1', 'browser');
    ledger.recordFetch('https://b.example/', 'http');
    ledger.recordSourceFailure({
      tool: 'web_search',
      host: 'c.example',
      stage: 'fetch',
      reason: 'fetch failed',
    });
    ledger.recordSourceFailure({
      tool: 'web_search',
      host: 'd.example',
      stage: 'policy',
      reason: 'policy',
    });
    ledger.recordBudgetExhaustion('navigations', 'web_search', 3);
    ledger.recordBrowserLaunch();

    const summary = ledger.summary({
      runId: 'run-1',
      snapshot: { navigations: 30, hosts: 4 },
      limits: { maxNavigations: 30, maxHosts: 20 },
      noticeCount: 4,
    });

    expect(summary).toEqual({
      schema_version: 1,
      run_id: 'run-1',
      searches: {
        total: 3,
        ok: 1,
        failed_by_code: { SEARCH_BLOCKED: 1, TOOL_TIMEOUT: 1 },
        providers: ['duckduckgo'],
      },
      fetches: {
        total: 3,
        by_mode: { http: 2, browser: 1 },
        repeat_fetches: 1,
        failed_by_code: { FETCH_TIMEOUT: 1 },
        cache_hits: 0,
        memo_hits: 0,
        challenges: { http: 0, browser: 0 },
      },
      source_failures: { fetch: 1, extract: 0, blocked: 0, budget: 3, policy: 1 },
      browser: { launches: 1 },
      budgets: {
        navigations_used: 30,
        navigations_limit: 30,
        hosts_used: 4,
        hosts_limit: 20,
        exhausted: ['wall-clock-soft', 'navigations'],
      },
      tool_failures: {
        total: 5,
        by_code: {
          SEARCH_BLOCKED: 1,
          TOOL_TIMEOUT: 1,
          EVIDENCE_FROZEN: 1,
          FETCH_TIMEOUT: 1,
          BUDGET_EXHAUSTED: 1,
        },
      },
      notices: 4,
    });
    expect(RunHealth.safeParse(summary).success).toBe(true);
    const failed = Object.values(summary.searches.failed_by_code).reduce((sum, n) => sum + n, 0);
    expect(summary.searches.total).toBe(summary.searches.ok + failed);
  });

  it('summarizes an empty run as all zeros and validates', () => {
    const summary = new RunHealthLedger().summary({
      runId: 'run-empty',
      snapshot: { navigations: 0, hosts: 0 },
      limits: { maxNavigations: Number.POSITIVE_INFINITY, maxHosts: 20 },
      noticeCount: 0,
    });

    expect(summary.searches).toEqual({ total: 0, ok: 0, failed_by_code: {}, providers: [] });
    expect(summary.budgets.navigations_limit).toBe(0);
    expect(RunHealth.safeParse(summary).success).toBe(true);
  });

  it('carries no message, URL, or page text: only counts, codes, and names', () => {
    const ledger = new RunHealthLedger();
    ledger.recordSourceFailure({
      tool: 'web_search',
      host: 'a.example',
      stage: 'fetch',
      reason: 'connect failed https://a.example/secret?token=CANARY',
    });
    ledger.recordFetch('https://a.example/secret?token=CANARY', 'http');

    const summary = ledger.summary({
      runId: 'run-1',
      snapshot: { navigations: 1, hosts: 1 },
      limits: { maxNavigations: 30, maxHosts: 20 },
      noticeCount: 0,
    });

    expect(JSON.stringify(summary)).not.toMatch(/CANARY|https?:|secret/);
    assertRuntimeEventIsSafe({ event: 'run_health', ...summary }, ['CANARY']);
  });
});

describe('@no-llm RunHealthLedger — challenge pages (FEAT-050)', () => {
  function challengedLedger(): RunHealthLedger {
    const ledger = new RunHealthLedger();
    // walled.example challenged both tiers twice; open.example challenged
    // only the HTTP client and was then read in the browser.
    for (let i = 0; i < 2; i += 1) {
      ledger.recordTierEvent({
        kind: 'challenge',
        tier: 'http',
        marker: 'data-sitekey',
        host: 'walled.example',
      });
      ledger.recordTierEvent({
        kind: 'escalated',
        reason: 'http-challenge',
        host: 'walled.example',
      });
      ledger.recordTierEvent({
        kind: 'challenge',
        tier: 'browser',
        marker: 'data-sitekey',
        host: 'walled.example',
      });
    }
    ledger.recordTierEvent({
      kind: 'challenge',
      tier: 'http',
      marker: 'verify-you-are-human',
      host: 'open.example',
    });
    ledger.recordTierEvent({ kind: 'escalated', reason: 'http-challenge', host: 'open.example' });
    ledger.recordFetch('https://open.example/page', 'browser');
    return ledger;
  }

  it('derives one blocked notice per browser-challenged host and one disclosure per HTTP-only host', () => {
    const ledger = challengedLedger();

    expect(ledger.briefFacts().notices).toEqual([
      {
        kind: 'blocked',
        source: 'walled.example',
        reason:
          "walled.example served a human-verification page to Yantra's standard browser; " +
          '2 pages were not read.',
      },
      {
        kind: 'other',
        source: 'open.example',
        reason:
          "open.example refused Yantra's HTTP client with a human-verification page; the page " +
          'was read once in the standard browser.',
      },
    ]);
    for (const notice of ledger.briefFacts().notices) {
      expect(BriefNotice.safeParse(notice).success).toBe(true);
    }
  });

  it('does not claim a browser read for an HTTP-challenged host the browser never served', () => {
    const ledger = new RunHealthLedger();
    ledger.recordTierEvent({
      kind: 'challenge',
      tier: 'http',
      marker: 'data-sitekey',
      host: 'flaky.example',
    });

    expect(ledger.briefFacts().notices).toEqual([]);
  });

  it('reports a challenge once, not again as a per-source or web_fetch read failure', () => {
    const ledger = challengedLedger();
    ledger.recordSourceFailure({
      tool: 'web_search',
      host: 'walled.example',
      stage: 'blocked',
      reason: 'challenge page (data-sitekey)',
    });
    ledger.recordToolOutcome({
      tool: 'web_fetch',
      status: 'error',
      code: 'SITE_CHALLENGE',
      cause: 'challenge',
      host: 'walled.example',
    });

    const blocked = ledger.briefFacts().notices.filter((notice) => notice.kind === 'blocked');
    expect(blocked).toHaveLength(1);
  });

  it('counts challenges by tier in the summary, and the summary stays safe and valid', () => {
    const summary = challengedLedger().summary({
      runId: 'r',
      snapshot: { navigations: 3, hosts: 2 },
      limits: { maxNavigations: 30, maxHosts: 20 },
      noticeCount: 2,
      pagePool: { launches: 1, contexts: 3 },
    });

    expect(summary.fetches.challenges).toEqual({ http: 3, browser: 2 });
    expect(summary.browser).toEqual({ launches: 0, pool_launches: 1, contexts: 3 });
    expect(RunHealth.safeParse(summary).success).toBe(true);
    assertRuntimeEventIsSafe({ event: 'run_health', ...summary }, []);
  });
});

describe('@no-llm countingBrowserProvider', () => {
  function fakeProvider() {
    const session = { id: 's' } as unknown as BrowserSession;
    const install = { path: '/chrome' } as unknown as ChromeInstall;
    return {
      session,
      install,
      provider: {
        launch: vi.fn(() => Promise.resolve(session)),
        detectChrome: vi.fn(() => Promise.resolve(install)),
      } satisfies BrowserProvider,
    };
  }

  it('counts every successful launch across all callers sharing the provider', async () => {
    const ledger = new RunHealthLedger();
    const { provider, session } = fakeProvider();
    const counted = countingBrowserProvider(provider, ledger);

    // The controller, the SERP transport, and the fetch fallback all launch
    // through the same shared provider.
    const sessions = await Promise.all([
      counted.launch({ headless: true }),
      counted.launch({ profile: { kind: 'ephemeral' } }),
      counted.launch({}),
    ]);

    expect(sessions).toEqual([session, session, session]);
    expect(ledger.browserLaunches()).toBe(3);
    expect(provider.launch).toHaveBeenCalledWith({ headless: true });
  });

  it('does not count a failed launch and rethrows it unchanged', async () => {
    const ledger = new RunHealthLedger();
    const failure = new Error('no chrome');
    const counted = countingBrowserProvider(
      { launch: () => Promise.reject(failure), detectChrome: () => Promise.resolve(null) },
      ledger,
    );

    await expect(counted.launch({})).rejects.toBe(failure);
    expect(ledger.browserLaunches()).toBe(0);
  });

  it('delegates every BrowserProvider member', async () => {
    const { provider, install } = fakeProvider();
    const counted = countingBrowserProvider(provider, new RunHealthLedger());

    await expect(counted.detectChrome()).resolves.toBe(install);
    const members: readonly (keyof BrowserProvider)[] = ['launch', 'detectChrome'];
    for (const member of members) expect(typeof counted[member]).toBe('function');
  });
});

describe('@no-llm RunHealthLedger — extraction (FEAT-051)', () => {
  const summarize = (ledger: RunHealthLedger) =>
    ledger.summary({
      runId: 'run-x',
      snapshot: { navigations: 2, hosts: 1 },
      limits: { maxNavigations: 30, maxHosts: 20 },
      noticeCount: 0,
    });

  it('omits the block when no shape-aware read happened', () => {
    expect(summarize(new RunHealthLedger())).not.toHaveProperty('extraction');
  });

  it('counts a listing read and a discovered follow to an article', async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'yantra-run-health-extraction-'));
    try {
      const listing = 'https://cars.test/new/results';
      const detail = 'https://cars.test/vehicle/itm-01';
      const pages: Record<string, string> = { [listing]: listingHtml(), [detail]: articleHtml() };
      const ledger = new RunHealthLedger();
      const provenance = new UrlProvenance();
      provenance.seed({ goal: `read ${listing}` });
      const services = buildServices({
        runDir,
        runHealth: ledger,
        urlProvenance: provenance,
        fetch: {
          fetcher: {
            fetch: (url) =>
              Promise.resolve(fetchedDoc({ url, finalUrl: url, html: pages[url] ?? '' })),
          },
          extractor: new ReadabilityExtractor(),
        },
      });
      const tool = wrapTool(webFetchSpec(services), services);

      await tool.execute({ url: listing }, undefined);
      await tool.execute({ url: detail }, undefined);

      const summary = summarize(ledger);
      expect(summary.extraction).toMatchObject({
        pages_by_shape: { collection: 1, article: 1 },
        records_shown: 6,
        discovered_follows: 1,
        links_withheld: 0,
      });
      expect(summary.extraction?.links_offered).toBeGreaterThan(0);
      expect(RunHealth.safeParse(summary).success).toBe(true);
      expect(JSON.stringify(summary.extraction)).not.toMatch(/https?:|Teyra|Lakeside/u);
      assertRuntimeEventIsSafe({ event: 'run_health', ...summary }, ['Lakeside']);
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  });
});
