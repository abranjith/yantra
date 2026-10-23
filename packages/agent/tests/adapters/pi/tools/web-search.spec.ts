import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  EthicsRefusedError,
  FetchError,
  NoSearchProviderAvailableError,
  ReadabilityExtractor,
  SEARCH_PROVIDER_REGISTRY,
  ScrapeSearchError,
  type PageSource,
  type ContentFetcher,
  type DomainRankSignal,
  type EthicsGate,
  type ExtractedArticle,
  type FetchedDoc,
  type PageExtractor,
  type SearchProvider,
  type SearchResult,
} from '@yantra/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { webFetchSpec } from '../../../../src/adapters/pi/tools/web-fetch.js';
import { webSearchSpec } from '../../../../src/adapters/pi/tools/web-search.js';
import { wrapTool } from '../../../../src/runtime/middleware.js';

import { articleHtml, listingHtml } from './page-fixtures.js';
import {
  allowingEthics,
  buildServices,
  recordingRuntimeLogger,
  searchServiceFor,
  articlePageAnalysis,
  attestedHosts,
} from './test-support.js';

const CANARY = 'sk-SEARCHCANARYabcdefghijklmnop';

function hit(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    url: 'https://example.com/1',
    title: 'A result',
    snippet: 'a snippet',
    source: 'duckduckgo',
    rank: 1,
    publishedAt: null,
    ...overrides,
  };
}

function providerReturning(hits: readonly SearchResult[]): SearchProvider {
  return { name: 'duckduckgo', search: () => Promise.resolve(hits) };
}

function doc(url: string): FetchedDoc {
  return {
    url,
    finalUrl: url,
    fetchedAt: '2026-07-18T00:00:00.000Z',
    contentType: 'text/html',
    html: `<html><body><article>${url}</article></body></html>`,
    statusCode: 200,
    fetchMode: 'http',
    elapsedMs: 5,
  };
}

/** A fetcher keyed by URL: `timeout` hosts reject with a timeout FetchError. */
function keyedFetcher(): ContentFetcher {
  return {
    fetch: (url) =>
      url.includes('timeout')
        ? Promise.reject(new FetchError('slow', { url, kind: 'timeout' }))
        : Promise.resolve(doc(url)),
  };
}

/** An extractor returning per-URL body text (or null for `empty` hosts). */
function textExtractor(body: (url: string) => string | null): PageExtractor {
  const articleOf = (d: FetchedDoc): ExtractedArticle | null => {
    const text = body(d.finalUrl);
    return text === null
      ? null
      : {
          url: d.finalUrl,
          title: `Title ${d.finalUrl}`,
          byline: null,
          publishedAt: '2026-01-01T00:00:00.000Z',
          siteName: null,
          contentText: text,
          contentHtml: `<p>${text}</p>`,
          excerpt: `excerpt ${d.finalUrl}`,
          lengthChars: text.length,
        };
  };
  return {
    extract: (d) => Promise.resolve(articleOf(d)),
    extractPage: (d) => {
      const article = articleOf(d);
      return Promise.resolve({
        article,
        page: articlePageAnalysis(article?.contentText ?? null, d.fetchMode),
      });
    },
  };
}

interface SitePayload {
  readonly sites: {
    source_id: string;
    url: string;
    already_read?: boolean;
    excerpt?: string;
    text?: string;
    capture_ref?: string;
  }[];
  readonly more_results: { url: string }[];
  readonly failures: { url: string; stage: string; reason: string }[];
}

let runDir: string;
beforeEach(async () => {
  runDir = await mkdtemp(join(tmpdir(), 'yantra-search-'));
});
afterEach(async () => {
  await rm(runDir, { recursive: true, force: true });
});

describe('@no-llm web_search combined tool', () => {
  it('returns fetched sites under run-wide source IDs plus a more_results tail', async () => {
    const hits = Array.from({ length: 5 }, (_, i) =>
      hit({ url: `https://e${i}.com/`, rank: i + 1 }),
    );
    const services = buildServices({
      runDir,
      search: {
        service: searchServiceFor(providerReturning(hits)),
        resultCap: 5,
        fetchTop: 3,
      },
      fetch: {
        fetcher: keyedFetcher(),
        extractor: textExtractor((url) => `body for ${url}`),
        ethics: allowingEthics(),
        allowedContentTypes: ['text/html'],
        maxContentBytes: 1024 * 1024,
        captureThresholdBytes: 16 * 1024,
      },
    });
    const tool = wrapTool(webSearchSpec(services), services);

    const result = await tool.execute({ query: 'best cameras' }, undefined);

    expect(result.status).toBe('ok');
    const payload = JSON.parse(result.modelText) as SitePayload;
    expect(payload.sites.map((s) => s.source_id)).toEqual(['S1', 'S2', 'S3']);
    expect(payload.sites.some((s) => 'n' in s)).toBe(false);
    expect(payload.sites.map((s) => s.url)).toEqual([
      'https://e0.com/',
      'https://e1.com/',
      'https://e2.com/',
    ]);
    expect(payload.sites[0]?.text).toBe('body for https://e0.com/');
    expect(payload.more_results.map((r) => r.url)).toEqual(['https://e3.com/', 'https://e4.com/']);
    expect(payload.failures).toEqual([]);
    // Publish-steering note for small models: sources attach automatically,
    // so the note must point at result_publish and warn against re-searching.
    const withNote = JSON.parse(result.modelText) as { note?: string };
    expect(withNote.note).toMatch(/sources automatically/i);
    expect(withNote.note).toMatch(/result_publish/);
    expect(withNote.note).not.toMatch(/do not search again for the same topic/i);
    expect(withNote.note).toMatch(/search again only for a different part of the goal/i);
    expect(withNote.note).toMatch(/do not re-run a search you already ran/i);
    // Plain article text offers no links or records, so no deeper-reading advice.
    expect(withNote.note).not.toMatch(/links\[\] or records\[\]/u);
    // Every fetched site lands in the evidence ledger (ledger-authoritative
    // sources for result_publish), in rank order, with excerpts.
    expect(services.evidence.entries().map((entry) => entry.url)).toEqual([
      'https://e0.com/',
      'https://e1.com/',
      'https://e2.com/',
    ]);
    expect(services.evidence.entries()[0]?.tool).toBe('web_search');
    expect(services.evidence.entries()[0]?.excerpt).toBe(payload.sites[0]?.excerpt);
    // Every URL shown to the model — fetched sites AND the unfetched
    // "more results" tail — becomes navigable provenance, since the model is
    // being invited to follow them.
    for (const url of ['https://e0.com/', 'https://e2.com/', 'https://e3.com/']) {
      expect(services.urlProvenance.has(url)).toBe(true);
    }
    expect(services.urlProvenance.has('https://never-returned.com/')).toBe(false);
  });

  it('is rejected with EVIDENCE_FROZEN once the evidence phase is frozen', async () => {
    // Regression: after the completion nudge, a small model re-searched the
    // topic ("when was the 2022 world cup final") and published a different
    // conclusion than its own evidence-backed draft. The freeze makes the
    // nudge turn structurally publish-only.
    const services = buildServices({ runDir });
    services.evidencePhase.freeze();
    const tool = wrapTool(webSearchSpec(services), services);
    const result = await tool.execute({ query: 'best cameras' }, undefined);
    expect(result.status).toBe('error');
    expect(result.error_code).toBe('EVIDENCE_FROZEN');
    expect(result.retryable).toBe(false);
    expect(result.modelText).toContain('result_publish');
  });

  it('honors an explicit limit but never exceeds fetch_top', async () => {
    const hits = Array.from({ length: 5 }, (_, i) =>
      hit({ url: `https://e${i}.com/`, rank: i + 1 }),
    );
    const services = buildServices({
      runDir,
      search: {
        service: searchServiceFor(providerReturning(hits)),
        resultCap: 5,
        fetchTop: 2,
      },
      fetch: {
        fetcher: keyedFetcher(),
        extractor: textExtractor((url) => `body ${url}`),
        ethics: allowingEthics(),
        allowedContentTypes: ['text/html'],
        maxContentBytes: 1024 * 1024,
        captureThresholdBytes: 16 * 1024,
      },
    });
    const tool = wrapTool(webSearchSpec(services), services);

    const result = await tool.execute({ query: 'x', limit: 5 }, undefined);
    const payload = JSON.parse(result.modelText) as SitePayload;
    expect(payload.sites).toHaveLength(2); // clamped to fetch_top
  });

  it('stores oversized site text as a 0600 capture reference', async () => {
    const big = 'lorem ipsum '.repeat(4000);
    const services = buildServices({
      runDir,
      search: {
        service: searchServiceFor(providerReturning([hit({ url: 'https://big.com/' })])),
        resultCap: 3,
        fetchTop: 3,
      },
      fetch: {
        fetcher: keyedFetcher(),
        extractor: textExtractor(() => big),
        ethics: allowingEthics(),
        allowedContentTypes: ['text/html'],
        maxContentBytes: 1024 * 1024,
        captureThresholdBytes: 1024,
      },
    });
    const tool = wrapTool(webSearchSpec(services), services);

    const result = await tool.execute({ query: 'x' }, undefined);

    const payload = JSON.parse(result.modelText) as SitePayload;
    expect(payload.sites[0]?.capture_ref).toMatch(/^cap-/);
    expect(payload.sites[0]?.text).toBeUndefined();
    const files = await readdir(join(runDir, 'captures'));
    expect(files).toHaveLength(1);
    const saved = await readFile(join(runDir, 'captures', files[0]!), 'utf8');
    expect(saved).toBe(big);
    if (process.platform !== 'win32') {
      const mode = (await stat(join(runDir, 'captures', files[0]!))).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it('isolates per-site failures (one timeout + one empty) while others succeed', async () => {
    const hits = [
      hit({ url: 'https://ok1.com/', rank: 1 }),
      hit({ url: 'https://timeout.com/', rank: 2 }),
      hit({ url: 'https://empty.com/', rank: 3 }),
      hit({ url: 'https://ok2.com/', rank: 4 }),
    ];
    const services = buildServices({
      runDir,
      search: {
        service: searchServiceFor(providerReturning(hits)),
        resultCap: 5,
        fetchTop: 4,
      },
      fetch: {
        fetcher: keyedFetcher(),
        extractor: textExtractor((url) => (url.includes('empty') ? null : `body ${url}`)),
        ethics: allowingEthics(),
        allowedContentTypes: ['text/html'],
        maxContentBytes: 1024 * 1024,
        captureThresholdBytes: 16 * 1024,
      },
    });
    const tool = wrapTool(webSearchSpec(services), services);

    const result = await tool.execute({ query: 'x' }, undefined);

    const payload = JSON.parse(result.modelText) as SitePayload;
    expect(payload.sites.map((s) => s.url)).toEqual(['https://ok1.com/', 'https://ok2.com/']);
    // Failures never mint, so the IDs stay dense.
    expect(payload.sites.map((s) => s.source_id)).toEqual(['S1', 'S2']);
    const stages = payload.failures.map((f) => f.stage).sort();
    expect(stages).toEqual(['extract', 'fetch']);
  });

  it('surfaces a URL-policy refusal as a per-site policy failure, not a whole-tool error', async () => {
    // The default URL policy requires https; an http hit is refused per-site.
    const hits = [
      hit({ url: 'http://insecure.com/', rank: 1 }),
      hit({ url: 'https://ok.com/', rank: 2 }),
    ];
    const services = buildServices({
      runDir,
      search: {
        service: searchServiceFor(providerReturning(hits)),
        resultCap: 5,
        fetchTop: 2,
      },
      fetch: {
        fetcher: keyedFetcher(),
        extractor: textExtractor((url) => `body ${url}`),
        ethics: allowingEthics(),
        allowedContentTypes: ['text/html'],
        maxContentBytes: 1024 * 1024,
        captureThresholdBytes: 16 * 1024,
      },
    });
    const tool = wrapTool(webSearchSpec(services), services);

    const result = await tool.execute({ query: 'x' }, undefined);

    expect(result.status).toBe('ok');
    const payload = JSON.parse(result.modelText) as SitePayload;
    expect(payload.sites.map((s) => s.url)).toEqual(['https://ok.com/']);
    const refused = payload.failures.find((f) => f.url === 'http://insecure.com/');
    // The run's own URL policy refused it: stage `policy`, never `blocked`.
    expect(refused?.stage).toBe('policy');
    expect(refused?.reason).toMatch(/url-policy/i);
  });

  it('surfaces an ethics block as a per-site blocked failure', async () => {
    const refusal = new EthicsRefusedError(
      {
        host: 'robots.com',
        rule: 'Disallow: /',
        reason: 'disallowed by robots.txt',
        source: 'robots',
      },
      { taskId: 't', runId: 'r', stepId: 'web_search' },
    );
    const refuseRobots: EthicsGate = {
      check: (url) => (url.includes('robots') ? Promise.reject(refusal) : Promise.resolve()),
    };
    const hits = [
      hit({ url: 'https://robots.com/', rank: 1 }),
      hit({ url: 'https://ok.com/', rank: 2 }),
    ];
    const services = buildServices({
      runDir,
      search: {
        service: searchServiceFor(providerReturning(hits)),
        resultCap: 5,
        fetchTop: 2,
      },
      fetch: {
        fetcher: keyedFetcher(),
        extractor: textExtractor((url) => `body ${url}`),
        ethics: refuseRobots,
        allowedContentTypes: ['text/html'],
        maxContentBytes: 1024 * 1024,
        captureThresholdBytes: 16 * 1024,
      },
    });
    const tool = wrapTool(webSearchSpec(services), services);

    const result = await tool.execute({ query: 'x' }, undefined);

    const payload = JSON.parse(result.modelText) as SitePayload;
    expect(payload.sites.map((s) => s.url)).toEqual(['https://ok.com/']);
    expect(payload.failures.find((f) => f.url === 'https://robots.com/')?.stage).toBe('blocked');
  });

  it('classifies a resolve-time NoSearchProviderAvailableError as non-retryable SEARCH_PROVIDER_UNAVAILABLE', async () => {
    const services = buildServices({
      runDir,
      search: {
        service: searchServiceFor(new NoSearchProviderAvailableError(['tavily'])),
        resultCap: 5,
        fetchTop: 3,
      },
    });
    const tool = wrapTool(webSearchSpec(services), services);

    const result = await tool.execute({ query: 'x' }, undefined);

    expect(result.status).toBe('error');
    expect(result.error_code).toBe('SEARCH_PROVIDER_UNAVAILABLE');
    expect(result.retryable).toBe(false);
    expect(result.modelText).toMatch(/yantra init/);
  });

  it('maps an unknown provider throw to non-retryable SEARCH_FAILED, never TOOL_EXECUTION_FAILED', async () => {
    const services = buildServices({
      runDir,
      search: {
        service: searchServiceFor({
          name: 'duckduckgo',
          search: () => Promise.reject(new Error('boom')),
        }),
        resultCap: 5,
        fetchTop: 3,
      },
    });
    const tool = wrapTool(webSearchSpec(services), services);

    const result = await tool.execute({ query: 'x' }, undefined);

    expect(result.status).toBe('error');
    expect(result.error_code).toBe('SEARCH_FAILED');
    expect(result.retryable).toBe(false);
    expect(result.modelText).not.toContain('boom');
  });

  it('reports a typed anomaly challenge as SEARCH_BLOCKED with provider-specific advice', async () => {
    const challenge = new ScrapeSearchError('DuckDuckGo served an anti-bot challenge', {
      provider: 'duckduckgo',
      code: 'anomaly-challenge',
    });
    const services = buildServices({
      runDir,
      search: {
        service: searchServiceFor({ name: 'duckduckgo', search: () => Promise.reject(challenge) }),
        resultCap: 5,
        fetchTop: 3,
      },
    });
    const tool = wrapTool(webSearchSpec(services), services);

    const result = await tool.execute({ query: 'x' }, undefined);

    expect(result.error_code).toBe('SEARCH_BLOCKED');
    expect(result.retryable).toBe(false);
    const parsed = JSON.parse(result.modelText) as { message: string };
    expect(parsed.message).toMatch(/^duckduckgo served an anti-bot challenge/);
  });

  it('sanitizes credential canaries out of untrusted page content', async () => {
    const services = buildServices({
      runDir,
      search: {
        service: searchServiceFor(providerReturning([hit({ url: 'https://c.com/' })])),
        resultCap: 3,
        fetchTop: 3,
      },
      fetch: {
        fetcher: keyedFetcher(),
        extractor: textExtractor(() => `leak ${CANARY} now`),
        ethics: allowingEthics(),
        allowedContentTypes: ['text/html'],
        maxContentBytes: 1024 * 1024,
        captureThresholdBytes: 16 * 1024,
      },
    });
    const tool = wrapTool(webSearchSpec(services), services);

    const result = await tool.execute({ query: 'x' }, undefined);

    expect(result.modelText).not.toContain(CANARY);
    expect(result.modelText).toContain('[redacted-api-key]');
  });

  it('bounds the model-visible result to maxBytesPerResult', async () => {
    const big = 'word '.repeat(20000);
    const services = buildServices({
      runDir,
      limits: { maxBytesPerResult: 4 * 1024 },
      search: {
        service: searchServiceFor(providerReturning([hit({ url: 'https://b.com/' })])),
        resultCap: 3,
        fetchTop: 3,
      },
      fetch: {
        fetcher: keyedFetcher(),
        extractor: textExtractor(() => big),
        ethics: allowingEthics(),
        allowedContentTypes: ['text/html'],
        maxContentBytes: 1024 * 1024,
        captureThresholdBytes: 1024 * 1024, // keep inline so bounding is exercised
      },
    });
    const tool = wrapTool(webSearchSpec(services), services);

    const result = await tool.execute({ query: 'x' }, undefined);

    expect(Buffer.byteLength(result.modelText, 'utf8')).toBeLessThanOrEqual(4 * 1024);
  });

  it('records every search hit and stage-mapped negatives for combined failures', async () => {
    const signals: DomainRankSignal[] = [];
    const hits = [
      hit({ url: 'https://ok.com/', rank: 1 }),
      hit({ url: 'https://timeout.com/', rank: 2 }),
      hit({ url: 'https://empty.com/', rank: 3 }),
      hit({ url: 'https://tail.com/', rank: 4 }),
    ];
    const services = buildServices({
      runDir,
      domain: { rank: { record: (signal) => signals.push(signal) } },
      search: {
        service: searchServiceFor(providerReturning(hits)),
        resultCap: 4,
        fetchTop: 3,
      },
      fetch: {
        fetcher: keyedFetcher(),
        extractor: textExtractor((url) => (url.includes('empty') ? null : `body ${url}`)),
      },
    });

    const result = await wrapTool(webSearchSpec(services), services).execute(
      { query: 'x' },
      undefined,
    );

    expect(result.status).toBe('ok');
    expect(signals).toEqual([
      { domain: 'ok.com', delta: 1, reason: 'search_result' },
      { domain: 'timeout.com', delta: 1, reason: 'search_result' },
      { domain: 'timeout.com', delta: -1, reason: 'fetch_failed' },
      { domain: 'empty.com', delta: 1, reason: 'search_result' },
      { domain: 'empty.com', delta: -1, reason: 'extract_failed' },
      { domain: 'tail.com', delta: 1, reason: 'search_result' },
    ]);
  });

  it('does not let a throwing rank sink alter the combined tool result', async () => {
    const services = buildServices({
      runDir,
      domain: {
        rank: {
          record: () => {
            throw new Error('rank sink unavailable');
          },
        },
      },
      search: {
        service: searchServiceFor(providerReturning([hit({ url: 'https://ok.com/' })])),
      },
      fetch: {
        fetcher: keyedFetcher(),
        extractor: textExtractor(() => 'body'),
      },
    });

    const result = await wrapTool(webSearchSpec(services), services).execute(
      { query: 'x' },
      undefined,
    );

    expect(result.status).toBe('ok');
  });
});

describe("@no-llm web_search — the run's own budget and URL policy (FEAT-048 G6)", () => {
  function searchServices(
    hits: readonly SearchResult[],
    options: {
      readonly limits?: NonNullable<Parameters<typeof buildServices>[0]>['limits'];
      readonly signals?: DomainRankSignal[];
      readonly ethics?: EthicsGate;
    } = {},
  ) {
    return buildServices({
      runDir,
      // The suite also web_fetches search hosts directly; attest them as the user would.
      urlProvenance: attestedHosts('x.example', 'y.example', 'z.example', 'a.example', 'b.example'),
      ...(options.limits ? { limits: options.limits } : {}),
      domain: { rank: { record: (signal) => options.signals?.push(signal) } },
      search: {
        service: searchServiceFor(providerReturning(hits)),
        resultCap: 5,
        fetchTop: 5,
      },
      fetch: {
        fetcher: keyedFetcher(),
        extractor: textExtractor((url) => `body ${url}`),
        ethics: options.ethics ?? allowingEthics(),
        allowedContentTypes: ['text/html'],
        maxContentBytes: 1024 * 1024,
        captureThresholdBytes: 16 * 1024,
      },
    });
  }

  interface BudgetPayload extends SitePayload {
    readonly budget?: { exhausted: string; skipped_reads: number; message: string };
  }

  it('reports navigation exhaustion once at the top, never per site, and records no rank penalty', async () => {
    const signals: DomainRankSignal[] = [];
    const hits = [
      hit({ url: 'https://one.example/', rank: 1 }),
      hit({ url: 'https://two.example/', rank: 2 }),
      hit({ url: 'https://three.example/', rank: 3 }),
    ];
    const services = searchServices(hits, { limits: { maxNavigations: 1 }, signals });

    const result = await wrapTool(webSearchSpec(services), services).execute(
      { query: 'x' },
      undefined,
    );

    expect(result.status).toBe('ok');
    const payload = JSON.parse(result.modelText) as BudgetPayload;
    expect(payload.sites).toHaveLength(1);
    expect(payload.failures.filter((f) => f.stage === 'blocked' || f.stage === 'budget')).toEqual(
      [],
    );
    expect(payload.budget).toMatchObject({ exhausted: 'navigations', skipped_reads: 2 });
    expect(payload.budget?.message).toMatch(/Yantra's own navigation budget/);
    expect(payload.budget?.message).toContain('result_publish');
    expect(signals.every((signal) => signal.reason === 'search_result')).toBe(true);
    expect([...services.runHealth.budgetExhaustions()]).toEqual([
      ['navigations', { firstTool: 'web_search', skippedReads: 2 }],
    ]);
    expect(services.runHealth.sourceFailures()).toEqual([]);
    expect(services.runHealth.fetches()).toHaveLength(1);
  });

  it('names the hosts limit when the distinct-host budget is what ran out', async () => {
    const hits = [
      hit({ url: 'https://one.example/', rank: 1 }),
      hit({ url: 'https://two.example/', rank: 2 }),
    ];
    const services = searchServices(hits, { limits: { maxHosts: 1 } });

    const result = await wrapTool(webSearchSpec(services), services).execute(
      { query: 'x' },
      undefined,
    );

    const payload = JSON.parse(result.modelText) as BudgetPayload;
    expect(payload.budget).toMatchObject({ exhausted: 'hosts', skipped_reads: 1 });
    expect(payload.budget?.message).toMatch(/distinct-host budget/);
  });

  it('reports a URL_TOO_LONG hit as stage policy with no rank signal', async () => {
    const signals: DomainRankSignal[] = [];
    const longUrl = `https://long.example/${'a'.repeat(2100)}`;
    const services = searchServices([hit({ url: longUrl, rank: 1 })], { signals });

    const result = await wrapTool(webSearchSpec(services), services).execute(
      { query: 'x' },
      undefined,
    );

    const payload = JSON.parse(result.modelText) as BudgetPayload;
    expect(payload.failures).toHaveLength(1);
    expect(payload.failures[0]?.stage).toBe('policy');
    // Only the meter: no exhaustion report, because no budget refused a read.
    expect(payload.budget).toEqual({ navigations: '0/30', hosts: '0/20' });
    expect(signals).toEqual([{ domain: 'long.example', delta: 1, reason: 'search_result' }]);
    expect(services.runHealth.sourceFailures()).toMatchObject([
      { tool: 'web_search', host: 'long.example', stage: 'policy' },
    ]);
  });

  it('keeps an ethics robots refusal as stage blocked with a blocked rank signal', async () => {
    const signals: DomainRankSignal[] = [];
    const refusal = new EthicsRefusedError(
      {
        host: 'robots.example',
        rule: 'Disallow: /',
        reason: 'disallowed by robots.txt',
        source: 'robots',
      },
      { taskId: 't', runId: 'r', stepId: 'web_search' },
    );
    const services = searchServices([hit({ url: 'https://robots.example/', rank: 1 })], {
      signals,
      ethics: { check: () => Promise.reject(refusal) },
    });

    const result = await wrapTool(webSearchSpec(services), services).execute(
      { query: 'x' },
      undefined,
    );

    const payload = JSON.parse(result.modelText) as BudgetPayload;
    expect(payload.failures[0]?.stage).toBe('blocked');
    expect(signals).toEqual([
      { domain: 'robots.example', delta: 1, reason: 'search_result' },
      { domain: 'robots.example', delta: -1, reason: 'blocked' },
    ]);
  });

  it('records fetches (including fetched-but-unreadable pages) and per-site failures in the ledger', async () => {
    const hits = [
      hit({ url: 'https://ok.example/', rank: 1 }),
      hit({ url: 'https://timeout.example/', rank: 2 }),
    ];
    const services = buildServices({
      runDir,
      search: {
        service: searchServiceFor(providerReturning(hits)),
        resultCap: 5,
        fetchTop: 2,
      },
      fetch: {
        fetcher: keyedFetcher(),
        extractor: textExtractor(() => null),
      },
    });

    await wrapTool(webSearchSpec(services), services).execute({ query: 'x' }, undefined);

    expect(services.runHealth.fetches()).toEqual([
      { normalizedUrl: 'https://ok.example/', mode: 'http' },
    ]);
    expect(services.runHealth.sourceFailures().map((f) => `${f.host}:${f.stage}`)).toEqual([
      'ok.example:extract',
      'timeout.example:fetch',
    ]);
    expect(services.runHealth.toolOutcomes()).toMatchObject([
      { tool: 'web_search', status: 'ok', provider: 'duckduckgo' },
    ]);
  });
});

describe('@no-llm web_search — reads through the run document store (FEAT-050)', () => {
  /** A fetcher that records every network fetch it makes. */
  function countingFetcher(): { readonly calls: string[]; readonly fetcher: ContentFetcher } {
    const calls: string[] = [];
    return {
      calls,
      fetcher: {
        fetch: (url) => {
          calls.push(url);
          return Promise.resolve(doc(url));
        },
      },
    };
  }

  function storeServices(
    hits: readonly SearchResult[],
    options: {
      readonly fetcher?: ContentFetcher;
      readonly signals?: DomainRankSignal[];
      readonly fetchTop?: number;
      readonly limits?: NonNullable<Parameters<typeof buildServices>[0]>['limits'];
      readonly provider?: SearchProvider;
    } = {},
  ) {
    return buildServices({
      runDir,
      // The suite also web_fetches search hosts directly; attest them as the user would.
      urlProvenance: attestedHosts('x.example', 'y.example', 'z.example'),
      ...(options.limits ? { limits: options.limits } : {}),
      domain: { rank: { record: (signal) => options.signals?.push(signal) } },
      search: {
        service: searchServiceFor(options.provider ?? providerReturning(hits)),
        resultCap: 8,
        fetchTop: options.fetchTop ?? 3,
      },
      fetch: {
        fetcher: options.fetcher ?? keyedFetcher(),
        extractor: textExtractor((url) => `body ${url}`),
        ethics: allowingEthics(),
        allowedContentTypes: ['text/html'],
        maxContentBytes: 1024 * 1024,
        captureThresholdBytes: 16 * 1024,
      },
    });
  }

  const sixHits = Array.from({ length: 6 }, (_, i) =>
    hit({ url: `https://d${i}.example/`, title: `Hit ${i}`, snippet: `snip ${i}`, rank: i + 1 }),
  );

  interface DiscoveryPayload {
    readonly query: string;
    readonly mode: string;
    readonly results: { url: string; title: string | null; snippet: string | null }[];
    readonly note: string;
  }

  it('limit 0 discovers: no fetch, no navigation, every URL attested and observed', async () => {
    const counting = countingFetcher();
    const signals: DomainRankSignal[] = [];
    const services = storeServices(sixHits, { fetcher: counting.fetcher, signals });

    const result = await wrapTool(webSearchSpec(services), services).execute(
      { query: 'listing', limit: 0 },
      undefined,
    );

    expect(result.status).toBe('ok');
    expect(counting.calls).toEqual([]);
    expect(services.budgets.snapshot()).toMatchObject({ navigations: 0, hosts: 0 });
    const payload = JSON.parse(result.modelText) as DiscoveryPayload & Record<string, unknown>;
    expect(payload.mode).toBe('discovery');
    expect(payload.results).toHaveLength(6);
    expect(payload.results[0]).toEqual({
      url: 'https://d0.example/',
      title: 'Hit 0',
      snippet: 'snip 0',
    });
    expect(payload).not.toHaveProperty('sites');
    expect(payload).not.toHaveProperty('failures');
    expect(payload.note).toMatch(/web_fetch/);
    for (const entry of sixHits) expect(services.urlProvenance.has(entry.url)).toBe(true);
    expect(signals).toHaveLength(6);
    expect(signals.every((signal) => signal.reason === 'search_result')).toBe(true);
    // Discovery mints nothing and records no evidence: no page was read.
    expect(services.documents.entries()).toEqual([]);
    expect(services.evidence.isEmpty()).toBe(true);
    expect(services.runHealth.fetches()).toEqual([]);
  });

  it('limit 0 still reports a provider failure through the typed table', async () => {
    const services = storeServices([], {
      provider: {
        name: 'duckduckgo',
        search: () =>
          Promise.reject(
            new ScrapeSearchError('x', { provider: 'duckduckgo', code: 'empty-results' }),
          ),
      },
    });

    const result = await wrapTool(webSearchSpec(services), services).execute(
      { query: 'x', limit: 0 },
      undefined,
    );

    expect(result.error_code).toBe('SEARCH_NO_RESULTS');
  });

  it('a web_fetch of a hit a search already read is answered as already_read', async () => {
    const counting = countingFetcher();
    const hits = sixHits.slice(0, 3);
    const services = storeServices(hits, { fetcher: counting.fetcher });

    await wrapTool(webSearchSpec(services), services).execute({ query: 'a' }, undefined);
    const fetched = await wrapTool(webFetchSpec(services), services).execute(
      { url: 'https://d1.example/' },
      undefined,
    );

    expect(JSON.parse(fetched.modelText)).toMatchObject({ already_read: 'S2' });
    expect(counting.calls).toHaveLength(3);
  });

  it('a search hit already read by web_fetch is returned as already_read with its ID', async () => {
    const counting = countingFetcher();
    const hits = [
      hit({ url: 'https://x.example/', rank: 1 }),
      hit({ url: 'https://y.example/', rank: 2 }),
      hit({ url: 'https://z.example/', rank: 3 }),
    ];
    const signals: DomainRankSignal[] = [];
    const services = storeServices(hits, { fetcher: counting.fetcher, signals });
    await wrapTool(webFetchSpec(services), services).execute(
      { url: 'https://x.example/' },
      undefined,
    );
    signals.length = 0;

    const result = await wrapTool(webSearchSpec(services), services).execute(
      { query: 'q' },
      undefined,
    );

    const payload = JSON.parse(result.modelText) as SitePayload;
    expect(payload.sites[0]).toEqual({
      source_id: 'S1',
      url: 'https://x.example/',
      title: 'Title https://x.example/',
      already_read: true,
    });
    expect(payload.sites.slice(1).map((site) => site.source_id)).toEqual(['S2', 'S3']);
    expect(payload.sites.slice(1).every((site) => typeof site.text === 'string')).toBe(true);
    expect(counting.calls).toHaveLength(3);
    // No evidence re-add and no rank delta for the page already read.
    expect(services.evidence.entries().map((entry) => entry.sourceId)).toEqual(['S1', 'S2', 'S3']);
    expect(signals.map((signal) => signal.domain)).not.toContain('x.example');
    expect(services.runHealth.cacheHitCount()).toBe(1);
  });

  it('two concurrent searches sharing a hit fetch it once', async () => {
    const counting = countingFetcher();
    const shared = hit({ url: 'https://shared.example/', rank: 1 });
    const services = storeServices([shared], { fetcher: counting.fetcher });
    const tool = wrapTool(webSearchSpec(services), services);

    const [left, right] = await Promise.all([
      tool.execute({ query: 'a' }, undefined),
      tool.execute({ query: 'b' }, undefined),
    ]);

    expect(counting.calls).toEqual(['https://shared.example/']);
    expect(services.budgets.snapshot().navigations).toBe(1);
    const sites = [left, right].map(
      (result) => (JSON.parse(result!.modelText) as SitePayload).sites[0],
    );
    expect(sites.map((site) => site?.source_id)).toEqual(['S1', 'S1']);
    expect(sites.filter((site) => site?.already_read === true)).toHaveLength(1);
    expect(services.evidence.entries()).toHaveLength(1);
  });

  it('every fetched site carries a distinct source_id and no per-call n', async () => {
    const services = storeServices(sixHits, { fetchTop: 5 });

    const result = await wrapTool(webSearchSpec(services), services).execute(
      { query: 'q', limit: 5 },
      undefined,
    );

    const payload = JSON.parse(result.modelText) as SitePayload;
    const ids = payload.sites.map((site) => site.source_id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(5);
    expect(payload.sites.some((site) => 'n' in site)).toBe(false);
    expect(
      services.evidence
        .entries()
        .map((entry) => entry.sourceId)
        .sort(),
    ).toEqual([...ids].sort());
  });

  it('a second search repeats a terminally failed hit from the memo, without a fetch or a new penalty', async () => {
    const calls: string[] = [];
    const missing = hit({ url: 'https://gone.example/', rank: 1 });
    const signals: DomainRankSignal[] = [];
    const services = storeServices([missing], {
      signals,
      fetcher: {
        fetch: (url) => {
          calls.push(url);
          return Promise.reject(
            new FetchError('404', { url, kind: 'http-status', statusCode: 404 }),
          );
        },
      },
    });
    const tool = wrapTool(webSearchSpec(services), services);

    await tool.execute({ query: 'a' }, undefined);
    const second = await tool.execute({ query: 'b' }, undefined);

    expect(calls).toHaveLength(1);
    const payload = JSON.parse(second.modelText) as SitePayload;
    expect(payload.failures).toEqual([
      { url: 'https://gone.example/', stage: 'fetch', reason: 'source returned HTTP 404' },
    ]);
    expect(signals.filter((signal) => signal.delta < 0)).toHaveLength(1);
    expect(services.runHealth.sourceFailures()).toHaveLength(1);
    expect(services.runHealth.memoHitCount()).toBe(1);
  });

  it('a timed-out hit is fetched again by a later search', async () => {
    const counting: string[] = [];
    let call = 0;
    const services = storeServices([hit({ url: 'https://flaky.example/', rank: 1 })], {
      fetcher: {
        fetch: (url) => {
          counting.push(url);
          call += 1;
          return call === 1
            ? Promise.reject(new FetchError('slow', { url, kind: 'timeout' }))
            : Promise.resolve(doc(url));
        },
      },
    });
    const tool = wrapTool(webSearchSpec(services), services);

    await tool.execute({ query: 'a' }, undefined);
    const second = await tool.execute({ query: 'b' }, undefined);

    expect(counting).toHaveLength(2);
    expect((JSON.parse(second.modelText) as SitePayload).sites[0]?.source_id).toBe('S1');
  });

  it('keeps FEAT-048 budget reporting with the store in the path', async () => {
    const signals: DomainRankSignal[] = [];
    const services = storeServices(sixHits.slice(0, 3), {
      limits: { maxNavigations: 1 },
      signals,
    });

    const result = await wrapTool(webSearchSpec(services), services).execute(
      { query: 'x' },
      undefined,
    );

    const payload = JSON.parse(result.modelText) as SitePayload & {
      budget?: { exhausted: string; skipped_reads: number };
    };
    expect(payload.sites).toHaveLength(1);
    expect(payload.budget).toMatchObject({ exhausted: 'navigations', skipped_reads: 2 });
    expect(payload.failures).toEqual([]);
    expect(signals.some((signal) => signal.reason === 'blocked')).toBe(false);
  });

  it('accepts limit 0 in its schema and still rejects a negative limit', async () => {
    const services = storeServices(sixHits);
    const tool = wrapTool(webSearchSpec(services), services);

    const negative = await tool.execute({ query: 'x', limit: -1 }, undefined);

    expect(negative.error_code).toBe('INVALID_INPUT');
    expect(webSearchSpec(services).description).toMatch(/limit 0/);
  });
});

describe('@no-llm web_search — the run search breaker (FEAT-050)', () => {
  const CHALLENGE_SERP =
    '<html><body><form id="challenge-form" action="//duckduckgo.com/anomaly.js"></form></body></html>';

  it('after a challenge, later searches return SEARCH_BLOCKED circuit-open with no browser use', async () => {
    let pageUses = 0;
    const pages: PageSource = {
      withPage: (fn) => {
        pageUses += 1;
        return fn({
          goto: () => Promise.resolve(null),
          waitForNavigation: () => Promise.resolve(null),
          // A field name asks for the search form's target; every other read
          // is the page DuckDuckGo answered the submission with.
          evaluate: <T, A>(_fn: (arg: A) => T, arg?: A) =>
            Promise.resolve(
              (typeof arg === 'string'
                ? 'https://html.duckduckgo.com/html/'
                : CHALLENGE_SERP) as unknown as T,
            ),
          close: () => Promise.resolve(),
          url: () => 'https://html.duckduckgo.com/html/',
          on: () => undefined,
        });
      },
    };
    const scraped = SEARCH_PROVIDER_REGISTRY.duckduckgo.create({
      keychain: {
        get: () => Promise.resolve(null),
        set: () => Promise.resolve(),
        delete: () => Promise.resolve(false),
        list: () => Promise.resolve([]),
        isAvailable: () => Promise.resolve(true),
      },
      pages,
      ethicsGate: { checkUrl: () => Promise.resolve({ ok: true }) },
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        debug: () => undefined,
      },
    });
    const runtimeLogger = recordingRuntimeLogger();
    const services = buildServices({
      runDir,
      runtimeLogger,
      search: { service: searchServiceFor(scraped), resultCap: 5, fetchTop: 3 },
    });
    const tool = wrapTool(webSearchSpec(services), services);

    const first = await tool.execute({ query: 'a' }, undefined);
    const second = await tool.execute({ query: 'b' }, undefined);
    const third = await tool.execute({ query: 'c' }, undefined);

    expect(first.error_code).toBe('SEARCH_BLOCKED');
    expect(first.details).toMatchObject({ cause: 'anomaly-challenge' });
    for (const later of [second, third]) {
      expect(later.error_code).toBe('SEARCH_BLOCKED');
      expect(later.retryable).toBe(false);
      expect(later.details).toMatchObject({ cause: 'circuit-open' });
      expect(later.modelText).toMatch(/closed for the rest of this run/);
    }
    // Only the first search reached the provider's browser page.
    expect(pageUses).toBe(1);
    const warns = runtimeLogger.lines.filter(
      (line) => line.event === 'tool_failure' && line.tool === 'web_search',
    );
    expect(warns.map((line) => line.cause)).toEqual([
      'anomaly-challenge',
      'circuit-open',
      'circuit-open',
    ]);
  });
});

describe('@no-llm web_search — shape summaries (FEAT-051)', () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'yantra-web-search-shape-'));
  });

  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  const LISTING = 'https://cars.test/new/results';
  const ARTICLE = 'https://news.test/battery-guide';

  function shapeServices(pages: Readonly<Record<string, string>>, hits: readonly SearchResult[]) {
    const calls: string[] = [];
    const services = buildServices({
      runDir,
      search: { service: searchServiceFor(providerReturning(hits)), resultCap: 8, fetchTop: 5 },
      fetch: {
        fetcher: {
          fetch: (url) => {
            calls.push(url);
            const html = pages[url] ?? '';
            return Promise.resolve({ ...doc(url), html });
          },
        },
        extractor: new ReadabilityExtractor(),
        ethics: allowingEthics(),
        allowedContentTypes: ['text/html'],
        maxContentBytes: 1024 * 1024,
        captureThresholdBytes: 16 * 1024,
      },
    });
    return {
      services,
      calls,
      search: wrapTool(webSearchSpec(services), services),
      fetch: wrapTool(webFetchSpec(services), services),
    };
  }

  const twoHits = [
    hit({ url: LISTING, title: 'Teyra for sale', rank: 1 }),
    hit({ url: ARTICLE, title: 'Sizing a backup battery', rank: 2 }),
  ];

  it('summarizes a listing site and keeps an article site as today, plus shape and coverage', async () => {
    const { search } = shapeServices(
      { [LISTING]: listingHtml(), [ARTICLE]: articleHtml() },
      twoHits,
    );

    const payload = JSON.parse((await search.execute({ query: 'teyra' }, undefined)).modelText) as {
      sites: Record<string, unknown>[];
    };
    const [listing, article] = payload.sites;

    expect(listing?.shape).toBe('collection');
    expect((listing?.records as unknown[]).length).toBeLessThanOrEqual(5);
    expect(
      (listing?.links as { kind: string }[]).every(
        (link) => link.kind === 'pagination' || link.kind === 'facet',
      ),
    ).toBe(true);
    expect(listing?.note).toMatch(/web_fetch of this URL returns its full records/u);
    // A site with links/records makes the deeper-reading move possible (FEAT-052).
    expect((payload as { note?: string }).note).toMatch(
      /To go deeper into a site above, follow its links\[\] or records\[\]\./u,
    );
    expect(listing?.text).toBeUndefined();

    expect(Object.keys(article ?? {}).sort()).toEqual(
      ['source_id', 'url', 'title', 'shape', 'published_at', 'excerpt', 'text', 'coverage'].sort(),
    );
    expect(article?.shape).toBe('article');
    const extracted = await new ReadabilityExtractor().extract({
      ...doc(ARTICLE),
      html: articleHtml(),
    });
    expect(article?.text).toBe(extracted?.contentText);
  });

  it('serves the full listing from the store on the next web_fetch, then already_read', async () => {
    const { services, calls, search, fetch } = shapeServices(
      { [LISTING]: listingHtml(), [ARTICLE]: articleHtml() },
      twoHits,
    );
    await search.execute({ query: 'teyra' }, undefined);
    const navigations = services.budgets.snapshot().navigations;

    const full = JSON.parse((await fetch.execute({ url: LISTING }, undefined)).modelText) as {
      from_store?: boolean;
      records: { id: string }[];
    };
    const third = JSON.parse((await fetch.execute({ url: LISTING }, undefined)).modelText) as {
      already_read?: string;
    };

    expect(full.from_store).toBe(true);
    expect(full.records.map((record) => record.id)).toEqual([
      'S1#r1',
      'S1#r2',
      'S1#r3',
      'S1#r4',
      'S1#r5',
      'S1#r6',
    ]);
    expect(calls.filter((url) => url === LISTING)).toHaveLength(1);
    expect(services.budgets.snapshot().navigations).toBe(navigations);
    expect(third.already_read).toBe('S1');
  });

  it('an article site counts as delivered in full: web_fetch says already_read', async () => {
    const { fetch, search } = shapeServices(
      { [LISTING]: listingHtml(), [ARTICLE]: articleHtml() },
      twoHits,
    );
    await search.execute({ query: 'teyra' }, undefined);

    const again = JSON.parse((await fetch.execute({ url: ARTICLE }, undefined)).modelText) as {
      already_read?: string;
    };

    expect(again.already_read).toBe('S2');
  });

  it('attests summary links, and links the summary trimmed only once the full view shows them', async () => {
    const { services, search, fetch } = shapeServices(
      { [LISTING]: listingHtml(), [ARTICLE]: articleHtml() },
      twoHits,
    );
    // Card 6's seller: its record is beyond the summary's five.
    const seller = 'https://cars.test/dealer/6';
    const facet = 'https://cars.test/new/results?drivetrain=AWD';

    await search.execute({ query: 'teyra' }, undefined);
    expect(services.urlProvenance.explain(facet)?.origin).toEqual({
      kind: 'discovered',
      sourceId: 'S1',
      linkKind: 'facet',
    });
    expect(services.urlProvenance.explain(seller)).toBeNull();

    await fetch.execute({ url: LISTING }, undefined);
    expect(services.urlProvenance.explain(seller)?.origin).toEqual({
      kind: 'discovered',
      sourceId: 'S1',
      linkKind: 'content',
    });
  });

  it('holds the per-site budget across five sites with no middleware truncation', async () => {
    const urls = [1, 2, 3, 4, 5].map((n) => `https://cars${n}.test/new/results`);
    const pages = Object.fromEntries(urls.map((url) => [url, listingHtml()]));
    const { search } = shapeServices(
      pages,
      urls.map((url, index) => hit({ url, rank: index + 1 })),
    );

    const result = await search.execute({ query: 'teyra' }, undefined);
    const payload = JSON.parse(result.modelText) as { sites: unknown[] };

    expect(payload.sites).toHaveLength(5);
    expect(Buffer.byteLength(result.modelText, 'utf8')).toBeLessThan(24 * 1024);
  });
});
