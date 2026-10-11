import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  EthicsRefusedError,
  FetchError,
  HybridContentFetcher,
  type DomainRankSignal,
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
