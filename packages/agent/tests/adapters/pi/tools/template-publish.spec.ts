import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseTemplate } from '@yantra/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createTemplatedReportPublisher,
  resultPublishSpec,
} from '../../../../src/adapters/pi/tools/result-publish.js';
import type { BudgetLimits } from '../../../../src/runtime/budget.js';
import { wrapTool } from '../../../../src/runtime/middleware.js';

import { buildServices } from './test-support.js';

const TEMPLATE = `---
name: exec-brief
---
# {{ title | text }}

## Summary
{{ summary | markdown, max_words=20 }}

## Risks
{{ risks | list, min=1, max=5 }}

## Sources
{{ sources }}
`;

function manifest() {
  const parsed = parseTemplate(TEMPLATE);
  if (!parsed.isOk) throw new Error(parsed.error.map((issue) => issue.message).join('; '));
  return parsed.value;
}

function validReport() {
  return {
    report: {
      title: 'Weekly update',
      summary: 'Delivery remains on track. [1]',
      risks: ['One dependency is still being monitored.'],
    },
  };
}

describe('@no-llm templated result_publish', () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'yantra-template-publish-'));
  });

  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  function setup(withEvidence = true, limits: Partial<BudgetLimits> = {}) {
    const template = manifest();
    let services = buildServices({ runDir, template, limits });
    if (withEvidence) {
      services.evidence.add({
        url: 'https://example.com/evidence',
        finalUrl: null,
        title: 'Evidence',
        excerpt: 'Verified delivery status.',
        fetchedAt: '2026-07-31T12:00:00.000Z',
        publishedAt: null,
        tool: 'web_fetch',
      });
    }
    services = {
      ...services,
      domain: {
        ...services.domain,
        publish: createTemplatedReportPublisher(runDir, template, {
          taskId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
          runId: services.runId,
          source: 'saved',
          name: 'exec-brief',
          evidence: () => services.evidence.entries(),
          now: () => new Date('2026-07-31T12:00:00.000Z'),
        }),
      },
    };
    return { services, tool: wrapTool(resultPublishSpec(services), services) };
  }

  it('publishes once, terminates, and writes the document artifact family', async () => {
    const { tool } = setup();
    const first = await tool.execute(validReport(), undefined);
    expect(first.status).toBe('ok');
    expect(first.terminate).toBe(true);
    await expect(access(join(runDir, 'document.json'))).resolves.toBeUndefined();
    await expect(access(join(runDir, 'document.md'))).resolves.toBeUndefined();
    await expect(access(join(runDir, 'document.html'))).resolves.toBeUndefined();

    const stored = JSON.parse(await readFile(join(runDir, 'document.json'), 'utf8')) as {
      sources: unknown[];
      slots: Record<string, unknown>;
    };
    expect(stored.sources).toHaveLength(1);
    expect(stored.slots).not.toHaveProperty('sources');

    const second = await tool.execute(validReport(), undefined);
    expect(second.error_code).toBe('ALREADY_PUBLISHED');
  });

  it('keeps publication open after REPORT_INVALID so a corrected retry succeeds', async () => {
    const { services, tool } = setup();
    const publisherInvalid = await services.domain.publish.publish({
      ...validReport().report,
      risks: ['1', '2', '3', '4', '5', '6'],
    });
    expect(publisherInvalid.isOk).toBe(false);
    if (!publisherInvalid.isOk) {
      expect(publisherInvalid.error.issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ pointer: 'report/risks' })]),
      );
    }
    const invalid = await tool.execute(
      {
        ...validReport(),
        report: { ...validReport().report, risks: ['1', '2', '3', '4', '5', '6'] },
      },
      undefined,
    );
    expect(invalid.error_code).toBe('INVALID_INPUT');
    expect(services.actionPhase.isClosed()).toBe(false);

    const contentInvalid = await tool.execute(
      { ...validReport(), report: { ...validReport().report, summary: 'Unknown citation [2].' } },
      undefined,
    );
    expect(contentInvalid.error_code).toBe('REPORT_INVALID');
    expect(contentInvalid.retryable).toBe(true);
    expect(contentInvalid.details).toMatchObject({ issues: expect.any(Array) });
    expect(services.actionPhase.isClosed()).toBe(false);

    expect((await tool.execute(validReport(), undefined)).status).toBe('ok');
  });

  it('publishes the document after the total tool-call budget is spent', async () => {
    // The reported failure was on the templated path: without the terminal-call
    // exemption, `result_publish` is denied and no document.* is ever written.
    const { services, tool } = setup(true, { totalToolCalls: 1, perToolCalls: 4 });
    expect(services.budgets.reserveCall('web_fetch').isOk).toBe(true);
    expect(services.budgets.reserveCall('web_fetch').isOk).toBe(false);

    const result = await tool.execute(validReport(), undefined);

    expect(result.status).toBe('ok');
    expect(result.terminate).toBe(true);
    await expect(access(join(runDir, 'document.json'))).resolves.toBeUndefined();
  });

  it('ignores supplied sources and permits an empty evidence ledger', async () => {
    const { services, tool } = setup(false);
    const direct = await services.domain.publish.publish({
      ...validReport().report,
      summary: 'No external evidence was needed.',
      sources: ['https://attacker.invalid'],
    });
    expect(direct.isOk).toBe(true);
    if (direct.isOk) expect(direct.value.brief.sources).toEqual([]);
    const result = await tool.execute(
      {
        ...validReport(),
        report: { ...validReport().report, sources: ['https://attacker.invalid'] },
      },
      undefined,
    );
    // The closed provider schema rejects model-supplied sources before publication.
    expect(result.error_code).toBe('INVALID_INPUT');

    const corrected = await tool.execute(
      {
        report: { ...validReport().report, summary: 'No external evidence was needed.' },
      },
      undefined,
    );
    expect(corrected.status).toBe('ok');
    const stored = JSON.parse(await readFile(join(runDir, 'document.json'), 'utf8')) as {
      sources: unknown[];
    };
    expect(stored.sources).toEqual([]);
  });
});
