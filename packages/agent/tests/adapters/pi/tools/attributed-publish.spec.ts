import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskContractBody, createBrief, validateBrief } from '@yantra/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createBriefPublisher,
  resultPublishSpec,
  runtimeFactsFor,
} from '../../../../src/adapters/pi/tools/result-publish.js';
import { wrapTool } from '../../../../src/runtime/middleware.js';
import {
  TaskContractStore,
  MISSING_CONTRACT_REASON,
} from '../../../../src/runtime/task-contract.js';

import { buildServices, recordingRuntimeLogger } from './test-support.js';

describe('@no-llm attributed publication', () => {
  let runDir: string;
  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'yantra-attributed-'));
  });
  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });
  function setup() {
    const logger = recordingRuntimeLogger();
    const services = buildServices({
      runDir,
      runtimeLogger: logger,
      publish: createBriefPublisher(runDir),
    });
    services.evidence.add({
      sourceId: 'S1',
      url: 'https://listings.test/',
      finalUrl: null,
      title: 'Dealer',
      excerpt: 'Dealer Price 43204 AWD',
      fetchedAt: '2026-10-10T00:00:00.000Z',
      publishedAt: null,
      tool: 'web_fetch',
    });
    return { services, logger, tool: wrapTool(resultPublishSpec(services), services) };
  }
  it('applies the contract to model arguments containing complete protocol identity and metadata', async () => {
    const { services, tool } = setup();
    await services.contract.declare(
      TaskContractBody.parse({
        deliverable: 'table',
        subject: 'cars',
        required_fields: ['price'],
        filters: [{ name: 'drivetrain', value: 'AWD' }],
        required_sources: ['listings.test'],
        ranking: null,
        limit: null,
        notes: null,
      }),
      services.nowIso(),
    );
    const input = createBrief({
      task_id: services.runId,
      title: 'AWD offers',
      overview: 'All requirements met.',
      metadata: { citation_verdict: { claims_checked: 0, flagged: 0, stripped: 0 } },
    });
    const result = await tool.execute({ brief: input }, undefined);
    expect(result.error_code).toBe('BRIEF_INVALID');
    expect(result.details).toMatchObject({
      issues: [expect.objectContaining({ cause: 'contract-table-missing' })],
    });
    await expect(access(join(runDir, 'brief.json'))).rejects.toThrow();
    expect(services.actionPhase.isClosed()).toBe(false);
  });
  it('reports invalid refs without artifacts or composition logs, then accepts correction', async () => {
    const { tool, logger } = setup();
    const input = {
      title: 'Cars',
      overview: '',
      table: { columns: ['Price'], rows: [[43204]], row_sources: [['S9']] },
    };
    const invalid = await tool.execute({ brief: input }, undefined);
    expect(invalid.error_code).toBe('BRIEF_INVALID');
    expect(invalid.details).toMatchObject({
      issues: [
        expect.objectContaining({ cause: 'reference-unknown', pointer: 'table/row_sources/0/0' }),
      ],
    });
    await expect(access(join(runDir, 'brief.json'))).rejects.toThrow();
    expect(logger.lines.filter((line) => line.event === 'brief_composed')).toHaveLength(0);
    expect(
      (
        await tool.execute(
          { brief: { ...input, table: { ...input.table, row_sources: [['S1']] } } },
          undefined,
        )
      ).status,
    ).toBe('ok');
    const brief: unknown = JSON.parse(await readFile(join(runDir, 'brief.json'), 'utf8'));
    expect(validateBrief(brief).isOk).toBe(true);
    expect(brief).toMatchObject({
      facets: { comparison: { row_citations: [[1]] } },
      sources: [{ cited: true }],
      metadata: { citation_verdict: { claims_checked: 1, flagged: 0, stripped: 0 } },
    });
    expect(logger.lines.filter((line) => line.event === 'brief_composed')).toHaveLength(1);
  });
  it('keeps unsupported values and emits summary, verdict and count-only log', async () => {
    const { tool, logger } = setup();
    const result = await tool.execute(
      {
        brief: {
          title: 'Cars',
          overview: 'Result',
          table: {
            columns: ['Price'],
            rows: [['canary-unsupported-price 41000']],
            row_sources: [['S1']],
          },
          constraints: [{ name: 'drivetrain', value: 'AWD', status: 'verified', sources: ['S1'] }],
          fulfillment: { met: true, unmet: [{ item: 'interior color', reason: 'not shown' }] },
        },
      },
      undefined,
    );
    expect(result.status).toBe('ok');
    for (const clause of [
      '1 cited and 0 consulted',
      'table of 1 rows',
      'conditions: 1 verified, 0 unverified, 0 not met',
      '1 contract gaps',
      '1 values not found',
    ])
      expect(result.modelText).toContain(clause);
    expect(result.details).toMatchObject({ composition: { table_rows: 1, flagged: 1 } });
    expect(JSON.stringify(logger.lines)).not.toContain('canary-unsupported-price');
    const brief: unknown = JSON.parse(await readFile(join(runDir, 'brief.json'), 'utf8'));
    expect(brief).toMatchObject({
      notices: [
        expect.objectContaining({ kind: 'contract_gap' }),
        expect.objectContaining({ kind: 'uncited_claim_flagged' }),
      ],
      metadata: { citation_verdict: { flagged: 1 } },
    });
  });
  it('places contract and composition notices before the independently capped run facts', () => {
    const { services } = setup();
    const contract = new TaskContractStore({
      runId: services.runId,
      runDir,
      command: 'research',
      required: true,
    });
    for (let i = 0; i < 12; i += 1)
      services.runHealth.recordToolOutcome({
        tool: 'web_search',
        status: 'error',
        code: `SEARCH_FAILURE_${i}`,
        cause: 'failure',
        provider: 'fixture',
      });
    const facts = runtimeFactsFor({ ...services, contract }, [
      { kind: 'contract_gap', source: 'task-contract', reason: 'Not delivered' },
    ]);
    expect(facts.notices).toHaveLength(12);
    expect(facts.notices[0]?.reason).toBe(MISSING_CONTRACT_REASON);
    expect(facts.notices[1]?.kind).toBe('contract_gap');
    expect(facts.notices.at(-1)?.reason).toContain('more run notices');
  });
  it('publishes required-cell placeholders and auto-added unknown conditions', async () => {
    const { services, tool } = setup();
    await services.contract.declare(
      TaskContractBody.parse({
        deliverable: 'table',
        subject: 'cars',
        required_fields: ['dealer', 'price'],
        filters: [{ name: 'drivetrain', value: 'AWD' }],
        required_sources: ['listings.test'],
        ranking: null,
        limit: null,
        notes: null,
      }),
      '2026-10-10T00:00:00.000Z',
    );
    const result = await tool.execute(
      {
        brief: {
          title: 'Cars',
          overview: '',
          table: { columns: ['Dealer', 'Price'], rows: [[null, 43204]], row_sources: [['S1']] },
        },
      },
      undefined,
    );
    expect(result.status).toBe('ok');
    const markdown = await readFile(join(runDir, 'brief.md'), 'utf8');
    expect(markdown).toContain('**Conditions:** drivetrain = AWD — unverified');
    expect(markdown).toContain('not shown on source');
  });
});
