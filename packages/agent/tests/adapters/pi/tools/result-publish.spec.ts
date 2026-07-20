import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createBrief } from '@yantra/protocol';
import { Type } from 'typebox';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createBriefPublisher,
  resultPublishSpec,
} from '../../../../src/adapters/pi/tools/result-publish.js';
import { webFetchSpec } from '../../../../src/adapters/pi/tools/web-fetch.js';
import {
  wrapTool,
  type DomainResult,
  type ToolWrapperSpec,
} from '../../../../src/runtime/middleware.js';

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

  it('rejects a payload without title/overview at the schema boundary, naming the field', async () => {
    // Regression (run 20260717T223950Z-research-03a436fd): gemma4:e4b sent
    // valid findings/sources but never a title, because `brief` was declared
    // Type.Unknown and the model was never structurally told the field exists.
    // The schema now surfaces the missing required field before the call runs.
    const services = buildServices({ runDir, publish: createBriefPublisher(runDir) });
    const tool = wrapTool(resultPublishSpec(services), services);
    const result = await tool.execute(
      {
        brief: {
          key_findings: [{ text: 'Backed claim. [1]', citations: [1] }],
          sources: ['https://example.com/evidence'],
        },
      },
      undefined,
    );
    expect(result.status).toBe('error');
    expect(result.error_code).toBe('INVALID_INPUT');
    expect(result.retryable).toBe(true);
    expect(result.modelText).toContain('title');
  });

  it('rejects an empty title at the schema boundary', async () => {
    const services = buildServices({ runDir, publish: createBriefPublisher(runDir) });
    const tool = wrapTool(resultPublishSpec(services), services);
    const result = await tool.execute({ brief: { title: '', overview: 'Answer.' } }, undefined);
    expect(result.status).toBe('error');
    expect(result.error_code).toBe('INVALID_INPUT');
    expect(result.modelText).toContain('title');
  });

  it('returns a structured BRIEF_INVALID error for schema-valid but content-invalid input', async () => {
    const services = buildServices({ runDir, publish: createBriefPublisher(runDir) });
    const tool = wrapTool(resultPublishSpec(services), services);
    const result = await tool.execute(
      { brief: { title: 'Bad content', overview: 'Answer. [1]', sources: ['not a url'] } },
      undefined,
    );
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

describe('@no-llm result_publish tool — agent-authored content', () => {
  const TASK_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
  let runDir: string;

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'yantra-publish-agent-'));
  });
  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  function agentPublisher() {
    return createBriefPublisher(runDir, { taskId: TASK_ID, runId: 'run-under-test' });
  }

  async function publishedBrief(): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(join(runDir, 'brief.json'), 'utf8')) as Record<
      string,
      unknown
    >;
  }

  it('builds and publishes a valid Brief from the natural model payload (regression: BRIEF_INVALID on every agent publish)', async () => {
    // The exact shape a model produces from the tool description and nudge:
    // plain-string findings and source URLs, no protocol identity fields.
    const services = buildServices({ runDir, publish: agentPublisher() });
    const tool = wrapTool(resultPublishSpec(services), services);

    const result = await tool.execute(
      {
        brief: {
          title: 'Latest football results',
          overview: 'Fixtures for today are listed on BBC Sport. [1]',
          key_findings: ['Many leagues have friendlies today.', 'Kick-off times are UK local.'],
          sources: [
            'https://www.bbc.co.uk/sport/football/scores-fixtures',
            { url: 'https://www.flashscore.com/', title: 'Flashscore' },
          ],
        },
      },
      undefined,
    );

    expect(result.status).toBe('ok');
    const brief = await publishedBrief();
    expect(brief.task_id).toBe(TASK_ID);
    expect(brief.schema_version).toBe('0.2');
    expect(brief.sources).toMatchObject([
      { n: 1, host: 'www.bbc.co.uk', title: null },
      { n: 2, host: 'www.flashscore.com', title: 'Flashscore' },
    ]);
    // String findings carry no citations and publish as explicit commentary.
    expect(brief.key_findings).toMatchObject([
      { text: 'Many leagues have friendlies today.', editorial: true, citations: [] },
      { text: 'Kick-off times are UK local.', editorial: true, citations: [] },
    ]);
    expect(brief.metadata).toMatchObject({ synthesis: 'llm', run_id: 'run-under-test' });
  });

  it('preserves object findings with citations as non-editorial', async () => {
    const services = buildServices({ runDir, publish: agentPublisher() });
    const tool = wrapTool(resultPublishSpec(services), services);

    const result = await tool.execute(
      {
        brief: {
          title: 'Cited answer',
          overview: 'Answer. [1]',
          key_findings: [{ text: 'Backed claim. [1]', citations: [1] }],
          sources: ['https://example.com/evidence'],
        },
      },
      undefined,
    );

    expect(result.status).toBe('ok');
    const brief = await publishedBrief();
    expect(brief.key_findings).toMatchObject([
      { text: 'Backed claim. [1]', citations: [1], editorial: false },
    ]);
  });

  it('rejects a citation that resolves to no declared source, with the agent-visible pointer', async () => {
    const services = buildServices({ runDir, publish: agentPublisher() });
    const tool = wrapTool(resultPublishSpec(services), services);

    const result = await tool.execute(
      {
        brief: {
          title: 'Bad citation',
          overview: 'Answer.',
          key_findings: [{ text: 'Cites a ghost.', citations: [7] }],
          sources: ['https://example.com/only-source'],
        },
      },
      undefined,
    );

    expect(result.status).toBe('error');
    expect(result.error_code).toBe('BRIEF_INVALID');
    expect(result.retryable).toBe(true);
    const details = result.details as { issues: { pointer: string }[] };
    expect(
      details.issues.some((issue) => issue.pointer.startsWith('key_findings/0/citations')),
    ).toBe(true);
  });

  it('rejects an unparsable source URL at the sources pointer', async () => {
    const services = buildServices({ runDir, publish: agentPublisher() });
    const tool = wrapTool(resultPublishSpec(services), services);

    const result = await tool.execute(
      {
        brief: { title: 'Bad source', overview: 'Answer.', sources: ['not a url'] },
      },
      undefined,
    );

    expect(result.status).toBe('error');
    expect(result.error_code).toBe('BRIEF_INVALID');
    const details = result.details as { issues: { pointer: string }[] };
    expect(details.issues.some((issue) => issue.pointer === 'sources/0/url')).toBe(true);
    // The message must tell a weak model the remedy: copy exact URLs from its
    // web tool results (observed failure: publishing sources: [{url: "N/A"}]).
    expect(result.modelText).toMatch(/copy them verbatim/i);
    expect(result.modelText).toMatch(/web_search/);
  });

  it('honors an explicit editorial: false on an uncited finding by rejecting it', async () => {
    const services = buildServices({ runDir, publish: agentPublisher() });
    const tool = wrapTool(resultPublishSpec(services), services);

    const result = await tool.execute(
      {
        brief: {
          title: 'Uncited claim',
          overview: 'Answer.',
          key_findings: [{ text: 'Asserted as fact.', citations: [], editorial: false }],
          sources: ['https://example.com/unrelated'],
        },
      },
      undefined,
    );

    expect(result.status).toBe('error');
    expect(result.error_code).toBe('BRIEF_INVALID');
    const details = result.details as { issues: { pointer: string }[] };
    expect(details.issues.some((issue) => issue.pointer === 'key_findings/0/citations')).toBe(true);
  });

  it('generates a task id when the publisher has no run context (back-compat callers)', async () => {
    const services = buildServices({ runDir, publish: createBriefPublisher(runDir) });
    const tool = wrapTool(resultPublishSpec(services), services);

    const result = await tool.execute(
      { brief: { title: 'No context', overview: 'Answer.' } },
      undefined,
    );

    expect(result.status).toBe('ok');
    const brief = await publishedBrief();
    expect(typeof brief.task_id).toBe('string');
    expect((brief.task_id as string).length).toBe(26);
  });
});

describe('@no-llm result_publish tool — ledger-authoritative sources', () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'yantra-publish-ledger-'));
  });
  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  async function publishedBrief(): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(join(runDir, 'brief.json'), 'utf8')) as Record<
      string,
      unknown
    >;
  }

  function withEvidence(): ReturnType<typeof buildServices> {
    const services = buildServices({ runDir, publish: createBriefPublisher(runDir) });
    services.evidence.add({
      url: 'https://news.example.com/final-report',
      finalUrl: null,
      title: 'Final report',
      excerpt: 'Spain beat Argentina in the final.',
      fetchedAt: '2026-07-19T22:05:00.000Z',
      publishedAt: '2026-07-19T22:00:00.000Z',
      tool: 'web_search',
    });
    services.evidence.add({
      url: 'https://stats.example.com/match',
      finalUrl: null,
      title: null,
      excerpt: null,
      fetchedAt: '2026-07-19T22:06:00.000Z',
      publishedAt: 'sometime yesterday',
      tool: 'web_fetch',
    });
    return services;
  }

  it('attaches ledger sources with excerpts and ignores model-supplied sources (regression: placeholder "N/A" sources)', async () => {
    const services = withEvidence();
    const tool = wrapTool(resultPublishSpec(services), services);

    // The exact failure shape observed in run logs: the model re-types sources
    // as placeholders instead of copying URLs from its earlier tool results.
    const result = await tool.execute(
      {
        brief: {
          title: 'Who won the final',
          overview: 'Spain won the final against Argentina.',
          sources: [{ url: 'N/A' }, 'not a url either'],
        },
      },
      undefined,
    );

    expect(result.status).toBe('ok');
    const brief = await publishedBrief();
    expect(brief.sources).toMatchObject([
      {
        n: 1,
        url: 'https://news.example.com/final-report',
        title: 'Final report',
        excerpt: 'Spain beat Argentina in the final.',
        fetched_at: '2026-07-19T22:05:00.000Z',
        published_at: '2026-07-19T22:00:00.000Z',
      },
      // Unparseable extraction-derived publication dates normalize to null
      // rather than failing validation of a runtime-attached source.
      { n: 2, url: 'https://stats.example.com/match', excerpt: null, published_at: null },
    ]);
  });

  it('coerces model findings to editorial text so ad-hoc citation numbers can never invalidate the Brief', async () => {
    const services = withEvidence();
    const tool = wrapTool(resultPublishSpec(services), services);

    // Citations like [7] point into the model's per-call web_search numbering,
    // not the run-wide ledger numbering — mis-attribution is worse than none.
    const result = await tool.execute(
      {
        brief: {
          title: 'Cited answer',
          overview: 'Answer. [1]',
          key_findings: [
            { text: 'Backed claim.', citations: [7] },
            'A bare string finding.',
            { note: 'junk entry with no text' },
          ],
        },
      },
      undefined,
    );

    expect(result.status).toBe('ok');
    const brief = await publishedBrief();
    expect(brief.key_findings).toMatchObject([
      { text: 'Backed claim.', citations: [], editorial: true },
      { text: 'A bare string finding.', citations: [], editorial: true },
    ]);
  });

  it('passes a complete protocol Brief through untouched even when the ledger has entries', async () => {
    // Internal/scripted callers publish fully-formed Briefs; replacing their
    // sources or coercing their typed findings would invalidate them.
    const services = withEvidence();
    const tool = wrapTool(resultPublishSpec(services), services);

    const complete = createBrief({
      task_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      title: 'Scripted result',
      overview: 'Answer. [1]',
      key_findings: [
        { text: 'Cited claim. [1]', citations: [1], editorial: false, facet: null, children: [] },
      ],
      sources: [
        {
          n: 1,
          url: 'https://scripted.example.com/evidence',
          final_url: null,
          host: 'scripted.example.com',
          title: 'Scripted evidence',
          excerpt: null,
          fetched_at: '2026-07-19T20:00:00.000Z',
          published_at: null,
        },
      ],
    });
    const result = await tool.execute({ brief: complete }, undefined);

    expect(result.status).toBe('ok');
    const brief = await publishedBrief();
    expect(brief.sources).toMatchObject([{ n: 1, url: 'https://scripted.example.com/evidence' }]);
    expect(brief.key_findings).toMatchObject([
      { text: 'Cited claim. [1]', citations: [1], editorial: false },
    ]);
  });

  it('publishes with an empty ledger exactly as before (browser-only runs keep model sources)', async () => {
    const services = buildServices({ runDir, publish: createBriefPublisher(runDir) });
    const tool = wrapTool(resultPublishSpec(services), services);

    const result = await tool.execute(
      {
        brief: {
          title: 'Legacy path',
          overview: 'Answer. [1]',
          sources: ['https://example.com/evidence'],
        },
      },
      undefined,
    );

    expect(result.status).toBe('ok');
    const brief = await publishedBrief();
    expect(brief.sources).toMatchObject([{ n: 1, url: 'https://example.com/evidence' }]);
  });

  it('stamps the runtime-assembly path honestly in metadata and notices', async () => {
    const publisher = createBriefPublisher(runDir, { runId: 'run-under-test' });

    const published = await publisher.publish(
      {
        title: 'Assembled result',
        overview: 'The draft answer, packaged by the runtime.',
        sources: ['https://news.example.com/final-report'],
      },
      { assembledByRuntime: true },
    );

    expect(published.isOk).toBe(true);
    const brief = await publishedBrief();
    expect(brief.metadata).toMatchObject({
      synthesis: 'llm',
      deterministic_fallback_used: true,
    });
    expect(brief.notices).toMatchObject([{ source: 'runtime', kind: 'other' }]);
  });
});
