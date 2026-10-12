import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  EthicsRefusedError,
  FetchError,
  HybridContentFetcher,
  type ContentFetcher,
  type DomainRankSignal,
  type FetchedDoc,
} from '@yantra/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  WEB_FETCH_FAILURE_CAUSES,
  webFetchSpec,
} from '../../../../src/adapters/pi/tools/web-fetch.js';
import { wrapTool } from '../../../../src/runtime/middleware.js';

import {
  buildServices,
  extractorReturning,
  fetchedDoc,
  fetcherReturning,
  refusingEthics,
} from './test-support.js';

const CANARY = 'sk-FETCHCANARYabcdefghijklmnop';

describe('@no-llm web_fetch tool', () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'yantra-fetch-'));
  });
  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  it('fetches, extracts, and returns bounded readable text', async () => {
    const services = buildServices({
      runDir,
      fetch: {
        fetcher: fetcherReturning(fetchedDoc()),
        extractor: extractorReturning('The quick brown fox jumps over the lazy dog.'),
      },
    });
    const tool = wrapTool(webFetchSpec(services), services);
    const result = await tool.execute({ url: 'https://example.com/a' }, undefined);
    expect(result.status).toBe('ok');
    expect(result.modelText).toContain('quick brown fox');
    // The fetched page lands in the evidence ledger (ledger-authoritative
    // sources for result_publish).
    expect(services.evidence.entries()).toMatchObject([
      { url: 'https://example.com/a', tool: 'web_fetch', title: 'Fixture Title' },
    ]);
    // A successfully fetched page is attested, so navigating to it is allowed.
    expect(services.urlProvenance.has('https://example.com/a')).toBe(true);
  });

  it('records nothing in provenance when the fetch does not produce a page', async () => {
    // A URL that could not be fetched and read attests nothing — otherwise a
    // failed guess would still earn the right to navigate to it.
    const services = buildServices({
      runDir,
      fetch: {
        fetcher: fetcherReturning(fetchedDoc()),
        extractor: extractorReturning(''),
      },
    });

    const result = await wrapTool(webFetchSpec(services), services).execute(
      { url: 'https://example.com/a' },
      undefined,
    );

    expect(result.error_code).toBe('EXTRACTION_EMPTY');
    expect(services.urlProvenance.has('https://example.com/a')).toBe(false);
  });

  it('is rejected with EVIDENCE_FROZEN once the evidence phase is frozen', async () => {
    // Regression: after the completion nudge, a small model re-searched the
    // topic and published a different (wrong) conclusion. The freeze makes the
    // nudge turn structurally publish-only.
    const services = buildServices({
      runDir,
      fetch: {
        fetcher: fetcherReturning(fetchedDoc()),
        extractor: extractorReturning('unused'),
      },
    });
    services.evidencePhase.freeze();
    const tool = wrapTool(webFetchSpec(services), services);
    const result = await tool.execute({ url: 'https://example.com/a' }, undefined);
    expect(result.status).toBe('error');
    expect(result.error_code).toBe('EVIDENCE_FROZEN');
    expect(result.retryable).toBe(false);
    expect(result.modelText).toContain('result_publish');
    expect(services.evidence.isEmpty()).toBe(true);
  });

  it('refuses a robots-blocked host with a typed refusal (no evasion path)', async () => {
    const refusal = new EthicsRefusedError(
      {
        host: 'example.com',
        rule: 'robots.txt',
        reason: 'Disallowed by robots.txt',
        source: 'robots',
      },
      { taskId: 't', runId: 'r', stepId: 'web_fetch' },
    );
    const services = buildServices({ runDir, fetch: { ethics: refusingEthics(refusal) } });
    const tool = wrapTool(webFetchSpec(services), services);
    const result = await tool.execute({ url: 'https://example.com/a' }, undefined);
    expect(result.status).toBe('error');
    expect(result.error_code).toBe('ETHICS_BLOCKED');
    expect(result.retryable).toBe(false);
  });

  it('refuses a non-text content type', async () => {
    const services = buildServices({
      runDir,
      fetch: { fetcher: fetcherReturning(fetchedDoc({ contentType: 'application/pdf' })) },
    });
    const tool = wrapTool(webFetchSpec(services), services);
    const result = await tool.execute({ url: 'https://example.com/a.pdf' }, undefined);
    expect(result.error_code).toBe('CONTENT_TYPE_REFUSED');
  });

  it('maps an over-size fetch to CONTENT_TOO_LARGE', async () => {
    const services = buildServices({
      runDir,
      fetch: {
        fetcher: {
          fetch: () =>
            Promise.reject(
              new FetchError('too big', { url: 'https://example.com/a', kind: 'too-large' }),
            ),
        },
      },
    });
    const tool = wrapTool(webFetchSpec(services), services);
    const result = await tool.execute({ url: 'https://example.com/a' }, undefined);
    expect(result.error_code).toBe('CONTENT_TOO_LARGE');
  });

  it('returns EXTRACTION_EMPTY with next-step guidance when no article extracts', async () => {
    const services = buildServices({
      runDir,
      fetch: { fetcher: fetcherReturning(fetchedDoc()), extractor: extractorReturning(null) },
    });
    const tool = wrapTool(webFetchSpec(services), services);
    const result = await tool.execute({ url: 'https://example.com/hub' }, undefined);
    expect(result.status).toBe('error');
    expect(result.error_code).toBe('EXTRACTION_EMPTY');
    expect(result.retryable).toBe(false);
    // The message must steer the agent to a different URL, not a blind retry.
    expect(result.modelText).toMatch(/article URL/i);
  });

  it('recovers a bot-refused fetch through the hybrid browser fallback (401/403 class)', async () => {
    const refusingHttp = {
      fetch: () =>
        Promise.reject(
          new FetchError('HTTP 403 while fetching content.', {
            url: 'https://example.com/a',
            kind: 'http-status',
            statusCode: 403,
          }),
        ),
    };
    const services = buildServices({
      runDir,
      fetch: {
        fetcher: new HybridContentFetcher({
          httpFetcher: refusingHttp,
          browserFetcher: fetcherReturning(fetchedDoc({ fetchMode: 'browser' })),
        }),
        extractor: extractorReturning('Rendered article content recovered via browser.'),
      },
    });
    const tool = wrapTool(webFetchSpec(services), services);
    const result = await tool.execute({ url: 'https://example.com/a' }, undefined);
    expect(result.status).toBe('ok');
    expect(result.modelText).toContain('Rendered article content recovered via browser.');
  });

  it('rejects a URL that fails the outbound policy with a stable code', async () => {
    const services = buildServices({ runDir });
    const tool = wrapTool(webFetchSpec(services), services);
    const result = await tool.execute(
      { url: 'https://evil.example/x?leak=sk-ABCDEFGHIJKLMNOPQRSTUVWX' },
      undefined,
    );
    expect(result.status).toBe('error');
    expect(result.error_code).toBe('URL_CREDENTIAL_SHAPE');
  });

  it('sanitizes credential canaries out of extracted content', async () => {
    const services = buildServices({
      runDir,
      fetch: {
        fetcher: fetcherReturning(fetchedDoc()),
        extractor: extractorReturning(`the api key is ${CANARY} in the body`),
      },
    });
    const tool = wrapTool(webFetchSpec(services), services);
    const result = await tool.execute({ url: 'https://example.com/a' }, undefined);
    expect(result.modelText).not.toContain(CANARY);
  });

  it('stores large content as a capture reference instead of inline', async () => {
    const big = 'lorem ipsum '.repeat(5000);
    const services = buildServices({
      runDir,
      fetch: {
        fetcher: fetcherReturning(fetchedDoc()),
        extractor: extractorReturning(big),
        captureThresholdBytes: 1024,
      },
    });
    const tool = wrapTool(webFetchSpec(services), services);
    const result = await tool.execute({ url: 'https://example.com/a' }, undefined);
    expect(result.status).toBe('ok');
    const payload = JSON.parse(result.modelText) as { capture_ref?: string };
    expect(payload.capture_ref).toMatch(/^cap-/);
    const files = await readdir(join(runDir, 'captures'));
    expect(files.length).toBe(1);
  });

  it('records blocked and fetch failures with the matching negative reason', async () => {
    const blockedSignals: DomainRankSignal[] = [];
    const refusal = new EthicsRefusedError(
      {
        host: 'blocked.example',
        rule: 'robots.txt',
        reason: 'Disallowed',
        source: 'robots',
      },
      { taskId: 't', runId: 'r', stepId: 'web_fetch' },
    );
    const blockedServices = buildServices({
      runDir,
      domain: { rank: { record: (signal) => blockedSignals.push(signal) } },
      fetch: { ethics: refusingEthics(refusal) },
    });
    const blocked = await wrapTool(webFetchSpec(blockedServices), blockedServices).execute(
      { url: 'https://blocked.example/a' },
      undefined,
    );
    expect(blocked.error_code).toBe('ETHICS_BLOCKED');
    expect(blockedSignals).toEqual([{ domain: 'blocked.example', delta: -1, reason: 'blocked' }]);

    const fetchSignals: DomainRankSignal[] = [];
    const fetchServices = buildServices({
      runDir,
      domain: { rank: { record: (signal) => fetchSignals.push(signal) } },
      fetch: {
        fetcher: {
          fetch: (url) => Promise.reject(new FetchError('timeout', { url, kind: 'timeout' })),
        },
      },
    });
    const failed = await wrapTool(webFetchSpec(fetchServices), fetchServices).execute(
      { url: 'https://slow.example/a' },
      undefined,
    );
    expect(failed.error_code).toBe('FETCH_TIMEOUT');
    expect(fetchSignals).toEqual([{ domain: 'slow.example', delta: -1, reason: 'fetch_failed' }]);
  });

  it.each([
    ['CONTENT_TYPE_REFUSED', 'application/pdf', false],
    ['EXTRACTION_EMPTY', 'text/html', true],
  ] as const)('records %s as an extraction failure', async (expectedCode, contentType, empty) => {
    const signals: DomainRankSignal[] = [];
    const services = buildServices({
      runDir,
      domain: { rank: { record: (signal) => signals.push(signal) } },
      fetch: {
        fetcher: fetcherReturning(fetchedDoc({ contentType })),
        extractor: extractorReturning(empty ? null : 'body'),
      },
    });

    const result = await wrapTool(webFetchSpec(services), services).execute(
      { url: 'https://content.example/a' },
      undefined,
    );

    expect(result.error_code).toBe(expectedCode);
    expect(signals).toEqual([{ domain: 'content.example', delta: -1, reason: 'extract_failed' }]);
  });

  it('does not let a throwing rank sink alter a fetch result', async () => {
    const services = buildServices({
      runDir,
      domain: {
        rank: {
          record: () => {
            throw new Error('rank sink unavailable');
          },
        },
      },
      fetch: { fetcher: fetcherReturning(fetchedDoc()), extractor: extractorReturning(null) },
    });

    const result = await wrapTool(webFetchSpec(services), services).execute(
      { url: 'https://example.com/a' },
      undefined,
    );

    expect(result.error_code).toBe('EXTRACTION_EMPTY');
  });
});

describe('@no-llm web_fetch — run-health diagnostics (FEAT-048)', () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'yantra-fetch-health-'));
  });
  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  /** True when `cause` is in the declared vocabulary (parametric entries by prefix). */
  function declared(cause: string): boolean {
    if ((WEB_FETCH_FAILURE_CAUSES as readonly string[]).includes(cause))
      return !cause.includes('<');
    if (/^budget:(navigations|hosts)$/.test(cause)) return true;
    if (/^ethics-refused:(robots|blocklist|rate-limit)$/.test(cause)) return true;
    return /^url-policy:url-[a-z-]+$/.test(cause);
  }

  it('records a successful fetch with its mode and host', async () => {
    const services = buildServices({
      runDir,
      fetch: {
        fetcher: fetcherReturning(fetchedDoc({ fetchMode: 'browser' })),
        extractor: extractorReturning('Readable text.'),
      },
    });

    await wrapTool(webFetchSpec(services), services).execute(
      { url: 'https://example.com/a' },
      undefined,
    );

    expect(services.runHealth.fetches()).toEqual([
      { normalizedUrl: 'https://example.com/a', mode: 'browser' },
    ]);
    expect(services.runHealth.toolOutcomes()).toEqual([
      { tool: 'web_fetch', status: 'ok', host: 'example.com', fetchMode: 'browser' },
    ]);
  });

  it('counts a fetched-but-unreadable page as a fetch and records the failure host', async () => {
    const services = buildServices({
      runDir,
      fetch: { fetcher: fetcherReturning(fetchedDoc()), extractor: extractorReturning('') },
    });

    await wrapTool(webFetchSpec(services), services).execute(
      { url: 'https://example.com/a' },
      undefined,
    );

    expect(services.runHealth.fetches()).toHaveLength(1);
    expect(services.runHealth.toolOutcomes()).toEqual([
      {
        tool: 'web_fetch',
        status: 'error',
        code: 'EXTRACTION_EMPTY',
        cause: 'extraction-empty',
        host: 'example.com',
      },
    ]);
  });

  it('attributes a navigation-budget refusal to the run, not the site', async () => {
    const signals: DomainRankSignal[] = [];
    const services = buildServices({
      runDir,
      limits: { maxNavigations: 1 },
      domain: { rank: { record: (signal) => signals.push(signal) } },
      fetch: {
        fetcher: fetcherReturning(fetchedDoc()),
        extractor: extractorReturning('Readable text.'),
      },
    });
    const tool = wrapTool(webFetchSpec(services), services);

    await tool.execute({ url: 'https://example.com/a' }, undefined);
    const refused = await tool.execute({ url: 'https://example.com/b' }, undefined);

    expect(refused.error_code).toBe('BUDGET_EXHAUSTED');
    expect([...services.runHealth.budgetExhaustions()]).toEqual([
      ['navigations', { firstTool: 'web_fetch', skippedReads: 1 }],
    ]);
    expect(services.runHealth.toolOutcomes()[1]).toMatchObject({
      status: 'error',
      cause: 'budget:navigations',
      host: 'example.com',
    });
    expect(signals).toEqual([]);
  });

  it('declares a closed cause for every failure path', async () => {
    const robots = new EthicsRefusedError(
      { host: 'example.com', rule: 'robots.txt', reason: 'Disallowed', source: 'robots' },
      { taskId: 't', runId: 'r', stepId: 'web_fetch' },
    );
    const failing = (error: unknown) => ({ fetch: () => Promise.reject(error) });
    const scenarios: {
      readonly name: string;
      readonly options: Parameters<typeof buildServices>[0];
      readonly url?: string;
    }[] = [
      { name: 'ethics', options: { fetch: { ethics: refusingEthics(robots) } } },
      {
        name: 'timeout',
        options: {
          fetch: { fetcher: failing(new FetchError('t', { url: 'u', kind: 'timeout' })) },
        },
      },
      {
        name: 'too-large',
        options: {
          fetch: { fetcher: failing(new FetchError('t', { url: 'u', kind: 'too-large' })) },
        },
      },
      {
        name: 'http-5xx',
        options: {
          fetch: {
            fetcher: failing(
              new FetchError('t', { url: 'u', kind: 'http-status', statusCode: 503 }),
            ),
          },
        },
      },
      {
        name: 'http-4xx',
        options: {
          fetch: {
            fetcher: failing(
              new FetchError('t', { url: 'u', kind: 'http-status', statusCode: 404 }),
            ),
          },
        },
      },
      {
        name: 'network',
        options: {
          fetch: { fetcher: failing(new FetchError('t', { url: 'u', kind: 'network' })) },
        },
      },
      {
        name: 'content-type',
        options: {
          fetch: { fetcher: fetcherReturning(fetchedDoc({ contentType: 'application/pdf' })) },
        },
      },
      { name: 'policy', options: {}, url: 'http://example.com/insecure' },
    ];

    const causes: string[] = [];
    for (const scenario of scenarios) {
      const services = buildServices({ runDir, ...scenario.options });
      await wrapTool(webFetchSpec(services), services).execute(
        { url: scenario.url ?? 'https://example.com/a' },
        undefined,
      );
      const outcome = services.runHealth.toolOutcomes()[0];
      expect({ scenario: scenario.name, status: outcome?.status, host: outcome?.host }).toEqual({
        scenario: scenario.name,
        status: 'error',
        host: 'example.com',
      });
      causes.push(outcome?.cause ?? '');
    }

    expect(causes).toEqual([
      'ethics-refused:robots',
      'timeout',
      'too-large',
      'http-5xx',
      'http-4xx',
      'network',
      'content-type-refused',
      'url-policy:url-insecure',
    ]);
    expect(causes.filter((cause) => !declared(cause))).toEqual([]);
  });
});

describe('@no-llm web_fetch — run document store (FEAT-050)', () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'yantra-fetch-store-'));
  });
  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  /** A fetcher that counts calls and serves each URL as its own page. */
  function countingFetcher(fail?: (url: string, call: number) => Error | null): {
    readonly calls: string[];
    readonly fetcher: ContentFetcher;
  } {
    const calls: string[] = [];
    return {
      calls,
      fetcher: {
        fetch: (url: string) => {
          calls.push(url);
          const error = fail?.(url, calls.length) ?? null;
          return error === null
            ? Promise.resolve(fetchedDoc({ url, finalUrl: url }))
            : Promise.reject(error);
        },
      },
    };
  }

  function parse(text: string): Record<string, unknown> {
    return JSON.parse(text) as Record<string, unknown>;
  }

  it('three reads of one URL make one fetch, charge one navigation, and repeat as already_read', async () => {
    const counting = countingFetcher();
    const services = buildServices({
      runDir,
      fetch: { fetcher: counting.fetcher, extractor: extractorReturning('Page body text.') },
    });
    const tool = wrapTool(webFetchSpec(services), services);

    const first = await tool.execute({ url: 'https://example.com/a' }, undefined);
    const second = await tool.execute({ url: 'https://example.com/a' }, undefined);
    const third = await tool.execute({ url: 'https://example.com/a#section' }, undefined);

    expect(counting.calls).toHaveLength(1);
    expect(services.budgets.snapshot().navigations).toBe(1);
    expect(parse(first.modelText)).toMatchObject({ source_id: 'S1', text: 'Page body text.' });
    const repeat = parse(second.modelText);
    expect(second.status).toBe('ok');
    expect(repeat).toMatchObject({ already_read: 'S1', source_id: 'S1', title: 'Fixture Title' });
    expect(repeat).not.toHaveProperty('text');
    expect(String(repeat.note)).toMatch(/already read earlier in this run/);
    expect(parse(third.modelText)).toMatchObject({ already_read: 'S1' });
    expect(services.runHealth.cacheHitCount()).toBe(2);
    expect(services.runHealth.fetches()).toHaveLength(1);
  });

  it('records the page in the ledger once, under its evidence ID', async () => {
    const counting = countingFetcher();
    const services = buildServices({
      runDir,
      fetch: { fetcher: counting.fetcher, extractor: extractorReturning('Body.') },
    });
    const tool = wrapTool(webFetchSpec(services), services);

    await tool.execute({ url: 'https://example.com/a' }, undefined);
    await tool.execute({ url: 'https://example.com/a' }, undefined);

    expect(services.evidence.entries()).toHaveLength(1);
    expect(services.evidence.entries()[0]).toMatchObject({ sourceId: 'S1', tool: 'web_fetch' });
    expect(services.documents.entries()).toMatchObject([
      { sourceId: 'S1', firstTool: 'web_fetch', fetchMode: 'http', reads: 2 },
    ]);
  });

  it('mints distinct, dense IDs for distinct pages', async () => {
    const counting = countingFetcher();
    const services = buildServices({
      runDir,
      fetch: { fetcher: counting.fetcher, extractor: extractorReturning('Body.') },
    });
    const tool = wrapTool(webFetchSpec(services), services);

    const a = await tool.execute({ url: 'https://example.com/a' }, undefined);
    const b = await tool.execute({ url: 'https://example.com/b' }, undefined);

    expect(parse(a.modelText).source_id).toBe('S1');
    expect(parse(b.modelText).source_id).toBe('S2');
  });

  it('memoizes a 404: a re-call makes no fetch and returns the same code, marked already attempted', async () => {
    const counting = countingFetcher(
      (url) => new FetchError('HTTP 404', { url, kind: 'http-status', statusCode: 404 }),
    );
    const services = buildServices({ runDir, fetch: { fetcher: counting.fetcher } });
    const tool = wrapTool(webFetchSpec(services), services);

    const first = await tool.execute({ url: 'https://example.com/missing' }, undefined);
    const second = await tool.execute({ url: 'https://example.com/missing' }, undefined);

    expect(counting.calls).toHaveLength(1);
    expect(first.error_code).toBe('FETCH_HTTP_ERROR');
    expect(second.error_code).toBe('FETCH_HTTP_ERROR');
    expect(second.retryable).toBe(false);
    expect(second.details).toMatchObject({ already_attempted: true });
    expect(second.modelText).toMatch(/already attempted earlier in this run/);
    expect(services.budgets.snapshot().navigations).toBe(1);
    expect(services.runHealth.memoHitCount()).toBe(1);
  });

  it('does not memoize a timeout: a re-call fetches again', async () => {
    const counting = countingFetcher((url, call) =>
      call === 1 ? new FetchError('slow', { url, kind: 'timeout' }) : null,
    );
    const services = buildServices({
      runDir,
      fetch: { fetcher: counting.fetcher, extractor: extractorReturning('Body.') },
    });
    const tool = wrapTool(webFetchSpec(services), services);

    const first = await tool.execute({ url: 'https://example.com/slow' }, undefined);
    const second = await tool.execute({ url: 'https://example.com/slow' }, undefined);

    expect(counting.calls).toHaveLength(2);
    expect(first.error_code).toBe('FETCH_TIMEOUT');
    expect(second.status).toBe('ok');
    expect(parse(second.modelText).source_id).toBe('S1');
  });

  it.each([
    [500, 2],
    [429, 2],
    [408, 2],
    [403, 1],
  ])('HTTP %s across two calls makes %s fetch(es)', async (status, fetches) => {
    const counting = countingFetcher(
      (url) => new FetchError('x', { url, kind: 'http-status', statusCode: status }),
    );
    const services = buildServices({ runDir, fetch: { fetcher: counting.fetcher } });
    const tool = wrapTool(webFetchSpec(services), services);

    await tool.execute({ url: 'https://example.com/x' }, undefined);
    await tool.execute({ url: 'https://example.com/x' }, undefined);

    expect(counting.calls).toHaveLength(fetches);
  });

  it('memoizes a robots refusal but not a rate-limit refusal', async () => {
    const refusal = (source: 'robots' | 'rate_limit') =>
      new EthicsRefusedError(
        { host: 'example.com', rule: 'r', reason: 'refused', source },
        { taskId: 't', runId: 'r', stepId: 'web_fetch' },
      );
    for (const [source, checks] of [
      ['robots', 1],
      ['rate_limit', 2],
    ] as const) {
      let ethicsChecks = 0;
      const services = buildServices({
        runDir,
        fetch: {
          ethics: {
            check: () => {
              ethicsChecks += 1;
              return Promise.reject(refusal(source));
            },
          },
        },
      });
      const tool = wrapTool(webFetchSpec(services), services);

      await tool.execute({ url: 'https://example.com/a' }, undefined);
      const second = await tool.execute({ url: 'https://example.com/a' }, undefined);

      expect({ source, checks: ethicsChecks }).toEqual({ source, checks });
      expect(second.error_code).toBe('ETHICS_BLOCKED');
      // An ethics refusal fetched nothing, so no navigation is charged.
      expect(services.budgets.snapshot().navigations).toBe(0);
    }
  });

  it('memoizes extraction-empty and refused content types', async () => {
    const cases: readonly { readonly doc: FetchedDoc; readonly text: string | null }[] = [
      { doc: fetchedDoc(), text: null },
      { doc: fetchedDoc({ contentType: 'application/pdf' }), text: 'unused' },
    ];
    for (const { doc, text } of cases) {
      let calls = 0;
      const services = buildServices({
        runDir,
        fetch: {
          fetcher: {
            fetch: () => {
              calls += 1;
              return Promise.resolve(doc);
            },
          },
          extractor: extractorReturning(text),
        },
      });
      const tool = wrapTool(webFetchSpec(services), services);

      await tool.execute({ url: 'https://example.com/a' }, undefined);
      await tool.execute({ url: 'https://example.com/a' }, undefined);

      expect(calls).toBe(1);
    }
  });

  it('a budget refusal is never memoized, and a page already read stays readable', async () => {
    const counting = countingFetcher();
    const services = buildServices({
      runDir,
      limits: { maxNavigations: 1 },
      fetch: { fetcher: counting.fetcher, extractor: extractorReturning('Body.') },
    });
    const tool = wrapTool(webFetchSpec(services), services);
    await tool.execute({ url: 'https://example.com/a' }, undefined);

    const refused = await tool.execute({ url: 'https://example.com/b' }, undefined);
    const refusedAgain = await tool.execute({ url: 'https://example.com/b' }, undefined);
    const repeatOfRead = await tool.execute({ url: 'https://example.com/a' }, undefined);

    expect(refused.error_code).toBe('BUDGET_EXHAUSTED');
    expect(refusedAgain.details).toBeNull();
    // The store answers a page already read without a navigation.
    expect(repeatOfRead.status).toBe('ok');
    expect(parse(repeatOfRead.modelText)).toMatchObject({ already_read: 'S1' });
    expect(counting.calls).toEqual(['https://example.com/a']);
  });

  it('a policy refusal never reaches the store, even for a page already recorded', async () => {
    const services = buildServices({ runDir });
    services.documents.observe('http://example.com/plain', {
      title: null,
      tool: 'browser_extract',
    });
    const tool = wrapTool(webFetchSpec(services), services);

    const refused = await tool.execute({ url: 'http://example.com/plain' }, undefined);

    expect(refused.error_code).toBe('URL_INSECURE');
  });

  it('a redirect target already read is answered from the store', async () => {
    const calls: string[] = [];
    const services = buildServices({
      runDir,
      fetch: {
        fetcher: {
          fetch: (url) => {
            calls.push(url);
            return Promise.resolve(fetchedDoc({ url, finalUrl: 'https://example.com/new' }));
          },
        },
        extractor: extractorReturning('Body.'),
      },
    });
    const tool = wrapTool(webFetchSpec(services), services);

    await tool.execute({ url: 'https://example.com/old' }, undefined);
    const landing = await tool.execute({ url: 'https://example.com/new' }, undefined);

    expect(calls).toEqual(['https://example.com/old']);
    expect(parse(landing.modelText)).toMatchObject({ already_read: 'S1' });
  });

  it('a repeat of a captured page carries the capture reference, not the text', async () => {
    const big = 'x'.repeat(20 * 1024);
    const services = buildServices({
      runDir,
      fetch: { fetcher: fetcherReturning(fetchedDoc()), extractor: extractorReturning(big) },
    });
    const tool = wrapTool(webFetchSpec(services), services);

    const first = parse(
      (await tool.execute({ url: 'https://example.com/a' }, undefined)).modelText,
    );
    const repeat = parse(
      (await tool.execute({ url: 'https://example.com/a' }, undefined)).modelText,
    );

    expect(first).toMatchObject({ source_id: 'S1' });
    expect(typeof first.capture_ref).toBe('string');
    expect(repeat).toMatchObject({ already_read: 'S1', capture_ref: first.capture_ref });
  });

  it('two concurrent calls for one URL make one fetch and charge one navigation', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const services = buildServices({
      runDir,
      fetch: {
        fetcher: {
          fetch: async (url) => {
            calls += 1;
            await gate;
            return fetchedDoc({ url, finalUrl: url });
          },
        },
        extractor: extractorReturning('Body.'),
      },
    });
    const tool = wrapTool(webFetchSpec(services), services);

    const pending = [
      tool.execute({ url: 'https://example.com/a' }, undefined),
      tool.execute({ url: 'https://example.com/a' }, undefined),
    ];
    release();
    const results = await Promise.all(pending);

    expect(calls).toBe(1);
    expect(services.budgets.snapshot().navigations).toBe(1);
    expect(results.map((result) => parse(result.modelText).source_id)).toEqual(['S1', 'S1']);
  });

  it('declares already-attempted as a closed cause', () => {
    expect(WEB_FETCH_FAILURE_CAUSES).toContain('already-attempted');
  });
});
