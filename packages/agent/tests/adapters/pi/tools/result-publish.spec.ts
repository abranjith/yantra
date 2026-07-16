import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createBrief } from '@yantra/protocol';
import { Type } from 'typebox';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createBriefPublisher, resultPublishSpec } from '../../../../src/adapters/pi/tools/result-publish.js';
import { webFetchSpec } from '../../../../src/adapters/pi/tools/web-fetch.js';
import { wrapTool, type DomainResult, type ToolWrapperSpec } from '../../../../src/runtime/middleware.js';

import { buildServices, extractorReturning, fetchedDoc, fetcherReturning } from './test-support.js';

function validBrief(): unknown {
  return createBrief({
    task_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    title: 'Test answer',
    overview: 'A plain answer with no inline citations.',
  });
}

describe('@no-llm result_publish tool', () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'yantra-publish-'));
  });
  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  it('publishes a valid Brief once and writes brief.html', async () => {
    const services = buildServices({ runDir, publish: createBriefPublisher(runDir) });
    const tool = wrapTool(resultPublishSpec(services), services);
    const result = await tool.execute({ brief: validBrief() }, undefined);
    expect(result.status).toBe('ok');
    expect(result.terminate).toBe(true);
    await expect(access(join(runDir, 'brief.html'))).resolves.toBeUndefined();
    await expect(access(join(runDir, 'brief.json'))).resolves.toBeUndefined();
  });

  it('rejects a second publish with ALREADY_PUBLISHED', async () => {
    const services = buildServices({ runDir, publish: createBriefPublisher(runDir) });
    const tool = wrapTool(resultPublishSpec(services), services);
    expect((await tool.execute({ brief: validBrief() }, undefined)).status).toBe('ok');
    const second = await tool.execute({ brief: validBrief() }, undefined);
    expect(second.status).toBe('error');
    expect(second.error_code).toBe('ALREADY_PUBLISHED');
  });

  it('returns a structured BRIEF_INVALID error for an invalid Brief', async () => {
    const services = buildServices({ runDir, publish: createBriefPublisher(runDir) });
    const tool = wrapTool(resultPublishSpec(services), services);
    const result = await tool.execute({ brief: { not: 'a brief' } }, undefined);
    expect(result.status).toBe('error');
    expect(result.error_code).toBe('BRIEF_INVALID');
    expect(result.retryable).toBe(true);
    const details = result.details as { issues?: unknown[] };
    expect(Array.isArray(details.issues)).toBe(true);
    expect((details.issues ?? []).length).toBeGreaterThan(0);
  });

  it('closes the action phase: mutating tools rejected, read tools still allowed', async () => {
    const services = buildServices({
      runDir,
      publish: createBriefPublisher(runDir),
      fetch: {
        fetcher: fetcherReturning(fetchedDoc()),
        extractor: extractorReturning('still readable after publish'),
      },
    });
    const publish = wrapTool(resultPublishSpec(services), services);
    expect((await publish.execute({ brief: validBrief() }, undefined)).status).toBe('ok');

    // A synthetic mutating tool is rejected once the phase is closed.
    const mutatingSpec: ToolWrapperSpec<ReturnType<typeof emptySchema>> = {
      name: 'browser_click',
      label: 'Click',
      description: 'Click an element. Do not use it after publishing.',
      parameters: emptySchema(),
      sanitizationProfile: 'public',
      mutating: true,
      run: vi.fn(async (): Promise<DomainResult> => ({ ok: true, model: {} })),
    };
    const mutating = wrapTool(mutatingSpec, services);
    const blocked = await mutating.execute({}, undefined);
    expect(blocked.error_code).toBe('ACTION_PHASE_CLOSED');
    expect(mutatingSpec.run).not.toHaveBeenCalled();

    // A read-only fetch still works.
    const fetch = wrapTool(webFetchSpec(services), services);
    const read = await fetch.execute({ url: 'https://example.com/a' }, undefined);
    expect(read.status).toBe('ok');
  });
});

function emptySchema() {
  return Type.Object({}, { additionalProperties: false });
}
