import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DefaultSanitizer, type FillCensus, type FillCensusSource } from '@yantra/core';
import { Brief } from '@yantra/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createBriefPublisher,
  evaluatePublication,
  resultPublishSpec,
} from '../../../../src/adapters/pi/tools/result-publish.js';
import { ActionLedger } from '../../../../src/runtime/action-ledger.js';
import { wrapTool } from '../../../../src/runtime/middleware.js';
import {
  TaskContractStore,
  normalizeContract,
  type TaskContractParams,
} from '../../../../src/runtime/task-contract.js';

import { buildServices, recordingRuntimeLogger } from './test-support.js';

describe('@no-llm result_publish judges a do run per item (FEAT-054)', () => {
  let runDir: string;
  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'yantra-fulfillment-'));
  });
  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  async function setup(
    command: 'do' | 'research',
    declared?: TaskContractParams,
    fillCensus?: FillCensusSource,
  ) {
    const logger = recordingRuntimeLogger();
    const contract = new TaskContractStore({ runId: 'r', runDir, command, required: true });
    if (declared !== undefined) {
      const body = normalizeContract(declared, { sanitizer: new DefaultSanitizer(), command });
      if (!body.isOk) throw new Error(`fixture rejected: ${body.error.cause}`);
      await contract.declare(body.value, '2026-10-15T12:00:00.000Z');
    }
    const built = buildServices({
      runDir,
      runtimeLogger: logger,
      contract,
      publish: createBriefPublisher(runDir),
      actionLedger: new ActionLedger({
        nowIso: () => '2026-10-15T12:00:00.000Z',
        locate: () => ({ epoch: 1, host: 'forms.example.test' }),
        sanitizer: new DefaultSanitizer(),
      }),
    });
    const services = fillCensus === undefined ? built : { ...built, fillCensus };
    services.evidence.add({
      sourceId: 'S1',
      url: 'https://forms.example.test/signup',
      finalUrl: null,
      title: 'Sign up',
      excerpt: 'A sign-up form.',
      fetchedAt: '2026-10-15T12:00:00.000Z',
      publishedAt: null,
      tool: 'browser_extract',
    });
    return { services, logger, tool: wrapTool(resultPublishSpec(services), services) };
  }

  const ACTIONS: TaskContractParams = {
    deliverable: 'actions',
    subject: 'the sign-up form',
    required_sources: ['forms.example.test'],
    artifacts: [{ kind: 'screenshot', scope: 'viewport' }],
    effects: { submit: 'forbidden' },
  };

  async function readBrief(): Promise<Brief> {
    return Brief.parse(JSON.parse(await readFile(join(runDir, 'brief.json'), 'utf8')));
  }

  it('writes schema-valid requirements, records the evaluation, and reports it to the model', async () => {
    const { services, tool, logger } = await setup('do', ACTIONS);
    services.actionLedger.record({
      kind: 'fill_committed',
      tool: 'browser_fill_form',
      ref: 'e1',
      field: 'Email',
      groupKey: null,
      covers: 1,
    });

    const result = await tool.execute(
      { brief: { title: 'Form filled', overview: 'Filled the form.' } },
      undefined,
    );

    expect(result.status).toBe('ok');
    const brief = await readBrief();
    expect(brief.requirements?.map((entry) => [entry.id, entry.status])).toEqual([
      ['deliverable', 'met'],
      ['artifact:screenshot:viewport', 'unmet'],
      ['effects.submit', 'met'],
    ]);
    expect(services.fulfillment.current()).toMatchObject({ met: 2, total: 3 });
    const payload = JSON.parse(result.modelText) as { requirements?: string };
    expect(payload.requirements).toBe(
      '2 of 3 met; viewport screenshot not captured (no browser was available)',
    );
    expect(logger.lines.filter((line) => line.event === 'fulfillment_evaluated')).toEqual([
      expect.objectContaining({ contract_declared: true, met: 2, unmet: 1, not_applicable: 0 }),
    ]);
    const log = JSON.stringify(
      logger.lines.filter((line) => line.event === 'fulfillment_evaluated'),
    );
    expect(log).not.toContain('screenshot');
  });

  it('adds one disagreement notice when the model claims met contrary to evidence', async () => {
    const { tool } = await setup('do', ACTIONS);

    await tool.execute(
      {
        brief: {
          title: 'Form filled',
          overview: 'Done.',
          fulfillment: { met: true, unmet: [] },
        },
      },
      undefined,
    );

    const notices = (await readBrief()).notices.filter((notice) => notice.source === 'fulfillment');
    expect(notices).toHaveLength(1);
    expect(notices[0]?.reason).toMatch(/evidence shows: .*no page action was recorded/u);
  });

  it('computes the outcome when the model omits fulfillment, with no notice', async () => {
    const { services, tool } = await setup('do', ACTIONS);

    await tool.execute({ brief: { title: 'Form', overview: 'Done.' } }, undefined);

    expect((await readBrief()).notices.some((notice) => notice.source === 'fulfillment')).toBe(
      false,
    );
    expect(services.fulfillment.current()).toMatchObject({ total: 3 });
  });

  it('leaves a research Brief without requirements and records no evaluation', async () => {
    const { services, tool, logger } = await setup('research', {
      deliverable: 'answer',
      subject: 'the sign-up form',
      required_sources: ['forms.example.test'],
    });

    const result = await tool.execute(
      { brief: { title: 'Form', overview: 'It asks for an email [S1].' } },
      undefined,
    );

    expect(result.status).toBe('ok');
    const raw = JSON.parse(await readFile(join(runDir, 'brief.json'), 'utf8')) as object;
    expect('requirements' in raw).toBe(false);
    expect('requirements' in (JSON.parse(result.modelText) as object)).toBe(false);
    expect(services.fulfillment.current()).toBeNull();
    expect(logger.lines.some((line) => line.event === 'fulfillment_evaluated')).toBe(false);
    expect(await readFile(join(runDir, 'brief.md'), 'utf8')).not.toContain('## Requirements');
  });

  it('renders the Requirements block in brief.md and brief.html', async () => {
    const { tool } = await setup('do', ACTIONS);

    await tool.execute({ brief: { title: 'Form', overview: 'Done.' } }, undefined);

    const markdown = await readFile(join(runDir, 'brief.md'), 'utf8');
    expect(markdown).toContain('## Requirements');
    expect(markdown).toContain(
      '- ✗ unmet: viewport screenshot — not captured (no browser was available)',
    );
    const html = await readFile(join(runDir, 'brief.html'), 'utf8');
    expect(html).toContain('<section class="requirements">');
  });

  it('evaluates a template publication without composition evidence', async () => {
    const { services } = await setup('do', ACTIONS);
    expect(await evaluatePublication(services, null)).toMatchObject({ total: 3, met: 1 });
  });

  it('reads the form census only when the contract declares a fill, exactly once', async () => {
    const source = {
      census: vi.fn(
        (): Promise<FillCensus> =>
          Promise.resolve({
            epoch: 1,
            host: 'forms.example.test',
            complete: true,
            controls: [{ ref: 'e1', groupKey: null, label: 'Email', exemption: null }],
          }),
      ),
    };
    const without = await setup('do', ACTIONS, source);
    await without.tool.execute({ brief: { title: 'Form', overview: 'Done.' } }, undefined);
    expect(source.census).toHaveBeenCalledTimes(0);

    await rm(runDir, { recursive: true, force: true });
    runDir = await mkdtemp(join(tmpdir(), 'yantra-fulfillment-'));
    const withFill = await setup('do', { ...ACTIONS, fill: { coverage: 'all_eligible' } }, source);
    withFill.services.actionLedger.record({
      kind: 'fill_committed',
      tool: 'browser_fill_form',
      ref: 'e1',
      field: 'Email',
      groupKey: null,
      covers: 1,
    });
    await withFill.tool.execute({ brief: { title: 'Form', overview: 'Done.' } }, undefined);
    expect(source.census).toHaveBeenCalledTimes(1);
    expect(
      withFill.services.fulfillment.current()?.items.find((i) => i.id === 'fill'),
    ).toMatchObject({ status: 'met', reason: 'fields 1 of 1 filled' });
  });

  it('reports a census that fails to read as incomplete, never as a failed publish', async () => {
    const source = { census: vi.fn(() => Promise.reject(new Error('page gone'))) };
    const { services, tool } = await setup(
      'do',
      { ...ACTIONS, fill: { coverage: 'all_eligible' } },
      source,
    );

    const result = await tool.execute({ brief: { title: 'Form', overview: 'Done.' } }, undefined);

    expect(result.status).toBe('ok');
    expect(services.fulfillment.current()?.items.find((i) => i.id === 'fill')?.reason).toBe(
      'fields not counted (inventory_incomplete)',
    );
  });
});
