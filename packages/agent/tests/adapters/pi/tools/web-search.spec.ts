import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  EthicsRefusedError,
  FetchError,
  type ContentFetcher,
  type DomainRankSignal,
  type EthicsGate,
  type Extractor,
  type FetchedDoc,
  type SearchProvider,
  type SearchResult,
} from '@yantra/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { webSearchSpec } from '../../../../src/adapters/pi/tools/web-search.js';
import { wrapTool } from '../../../../src/runtime/middleware.js';

import { buildServices, allowingEthics } from './test-support.js';

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
function textExtractor(body: (url: string) => string | null): Extractor {
  return {
    extract: (d) => {
      const text = body(d.finalUrl);
      return Promise.resolve(
        text === null
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
            },
      );
    },
  };
}

interface SitePayload {
  readonly sites: {
    n: number;
    url: string;
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
  it('returns fetched sites with n numbering plus a more_results tail', async () => {
    const hits = Array.from({ length: 5 }, (_, i) =>
      hit({ url: `https://e${i}.com/`, rank: i + 1 }),
    );
    const services = buildServices({
      runDir,
      search: {
        resolveProvider: () => Promise.resolve({ isOk: true, value: providerReturning(hits) }),
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
    expect(payload.sites.map((s) => s.n)).toEqual([1, 2, 3]);
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
    expect(withNote.note).toMatch(/do not search again/i);
    // Every fetched site lands in the evidence ledger (ledger-authoritative
    // sources for result_publish), in rank order, with excerpts.
    expect(services.evidence.entries().map((entry) => entry.url)).toEqual([
      'https://e0.com/',
      'https://e1.com/',
      'https://e2.com/',
    ]);
    expect(services.evidence.entries()[0]?.tool).toBe('web_search');
    expect(services.evidence.entries()[0]?.excerpt).toBe(payload.sites[0]?.excerpt);
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
        resolveProvider: () => Promise.resolve({ isOk: true, value: providerReturning(hits) }),
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
        resolveProvider: () =>
          Promise.resolve({
            isOk: true,
            value: providerReturning([hit({ url: 'https://big.com/' })]),
          }),
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
        resolveProvider: () => Promise.resolve({ isOk: true, value: providerReturning(hits) }),
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
    expect(payload.sites.map((s) => s.n)).toEqual([1, 2]);
    const stages = payload.failures.map((f) => f.stage).sort();
    expect(stages).toEqual(['extract', 'fetch']);
  });

  it('surfaces a URL-policy refusal as a per-site blocked failure, not a whole-tool error', async () => {
    // The default URL policy requires https; an http hit is refused per-site.
    const hits = [
      hit({ url: 'http://insecure.com/', rank: 1 }),
      hit({ url: 'https://ok.com/', rank: 2 }),
    ];
    const services = buildServices({
      runDir,
      search: {
        resolveProvider: () => Promise.resolve({ isOk: true, value: providerReturning(hits) }),
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
    const blocked = payload.failures.find((f) => f.url === 'http://insecure.com/');
    expect(blocked?.stage).toBe('blocked');
    expect(blocked?.reason).toMatch(/url-policy/i);
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
        resolveProvider: () => Promise.resolve({ isOk: true, value: providerReturning(hits) }),
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

  it('returns the stable SEARCH_PROVIDER_UNAVAILABLE retryable error when no provider resolves', async () => {
    const services = buildServices({
      runDir,
      search: {
        resolveProvider: () =>
          Promise.resolve({ isOk: false, error: { message: 'no key configured' } }),
        resultCap: 5,
        fetchTop: 3,
      },
    });
    const tool = wrapTool(webSearchSpec(services), services);

    const result = await tool.execute({ query: 'x' }, undefined);

    expect(result.status).toBe('error');
    expect(result.error_code).toBe('SEARCH_PROVIDER_UNAVAILABLE');
    expect(result.retryable).toBe(true);
  });

  it('maps a provider search throw to a retryable SEARCH_FAILED, not a crash', async () => {
    const services = buildServices({
      runDir,
      search: {
        resolveProvider: () =>
          Promise.resolve({
            isOk: true,
            value: { name: 'duckduckgo', search: () => Promise.reject(new Error('boom')) },
          }),
        resultCap: 5,
        fetchTop: 3,
      },
    });
    const tool = wrapTool(webSearchSpec(services), services);

    const result = await tool.execute({ query: 'x' }, undefined);

    expect(result.status).toBe('error');
    expect(result.error_code).toBe('SEARCH_FAILED');
    expect(result.retryable).toBe(true);
  });

  it('sanitizes credential canaries out of untrusted page content', async () => {
    const services = buildServices({
      runDir,
      search: {
        resolveProvider: () =>
          Promise.resolve({
            isOk: true,
            value: providerReturning([hit({ url: 'https://c.com/' })]),
          }),
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
        resolveProvider: () =>
          Promise.resolve({
            isOk: true,
            value: providerReturning([hit({ url: 'https://b.com/' })]),
          }),
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
        resolveProvider: () => Promise.resolve({ isOk: true, value: providerReturning(hits) }),
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
        resolveProvider: () =>
          Promise.resolve({
            isOk: true,
            value: providerReturning([hit({ url: 'https://ok.com/' })]),
          }),
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
