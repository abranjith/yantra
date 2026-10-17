import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseTemplate } from '@yantra/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createBriefPublisher,
  createTemplatedReportPublisher,
  resultPublishSpec,
} from '../../../../src/adapters/pi/tools/result-publish.js';
import { taskContractSpec } from '../../../../src/adapters/pi/tools/task-contract.js';
import type { BudgetLimits } from '../../../../src/runtime/budget.js';
import { wrapTool } from '../../../../src/runtime/middleware.js';
import type { AgenticCommand } from '../../../../src/runtime/profiles.js';
import {
  MISSING_CONTRACT_REASON,
  TaskContractStore,
} from '../../../../src/runtime/task-contract.js';

import { buildServices } from './test-support.js';

const BRIEF = { brief: { title: 'Form', overview: 'Filled the form.' } };
const CONTRACT = {
  deliverable: 'actions',
  subject: 'the sign-up form',
  effects: { submit: 'forbidden' },
} as const;

describe('@no-llm result_publish requires a contract in do (FEAT-054 D4)', () => {
  let runDir: string;
  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'yantra-contract-required-'));
  });
  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  function setup(command: AgenticCommand, limits: Partial<BudgetLimits> = {}) {
    const contract = new TaskContractStore({
      runId: 'r',
      runDir,
      command,
      required: command !== 'ask',
      requiredToPublish: command === 'do',
    });
    const services = buildServices({
      runDir,
      limits,
      contract,
      publish: createBriefPublisher(runDir),
    });
    return {
      services,
      publish: wrapTool(resultPublishSpec(services), services),
      declare: wrapTool(taskContractSpec(services), services),
    };
  }

  const exists = (path: string) =>
    access(path).then(
      () => true,
      () => false,
    );

  it('refuses a do publish without a contract, then one task_contract call recovers', async () => {
    const { services, publish, declare } = setup('do');

    const refused = await publish.execute(BRIEF, undefined);

    expect(refused.error_code).toBe('CONTRACT_REQUIRED');
    expect(refused.retryable).toBe(true);
    expect(refused.modelText).toMatch(/Call task_contract/u);
    expect(await exists(join(runDir, 'brief.json'))).toBe(false);
    expect(services.actionPhase.isClosed()).toBe(false);

    expect((await declare.execute(CONTRACT, undefined)).status).toBe('ok');
    const published = await publish.execute(BRIEF, undefined);

    expect(published.status).toBe('ok');
    const brief = JSON.parse(await readFile(join(runDir, 'brief.json'), 'utf8')) as {
      requirements?: unknown[];
    };
    expect(brief.requirements?.length).toBeGreaterThan(0);
  });

  it('recovers the same way after the soft wall-clock boundary', async () => {
    const { services, publish, declare } = setup('do', { softWallClockFraction: 0 });

    expect((await publish.execute(BRIEF, undefined)).error_code).toBe('CONTRACT_REQUIRED');
    expect((await declare.execute(CONTRACT, undefined)).status).toBe('ok');
    expect((await publish.execute(BRIEF, undefined)).status).toBe('ok');
    expect(services.budgets.softWindDownReached).toBe(true);
  });

  it('leaves research publishing without a contract unchanged, with the FEAT-052 notice', async () => {
    const { publish } = setup('research');

    const result = await publish.execute(BRIEF, undefined);

    expect(result.status).toBe('ok');
    const brief = JSON.parse(await readFile(join(runDir, 'brief.json'), 'utf8')) as {
      notices: { reason: string }[];
    };
    expect(brief.notices.map((notice) => notice.reason)).toContain(MISSING_CONTRACT_REASON);
  });

  it('leaves ask publishing without a contract unchanged', async () => {
    const { publish } = setup('ask');
    expect((await publish.execute(BRIEF, undefined)).status).toBe('ok');
  });

  it('refuses a templated do publish without a contract too', async () => {
    const parsed = parseTemplate('---\nname: brief\n---\n# {{ title | text }}\n');
    if (!parsed.isOk) throw new Error('template rejected');
    const contract = new TaskContractStore({
      runId: 'r',
      runDir,
      command: 'do',
      required: true,
      requiredToPublish: true,
    });
    const base = buildServices({ runDir, template: parsed.value, contract });
    const services = {
      ...base,
      domain: {
        ...base.domain,
        publish: createTemplatedReportPublisher(runDir, parsed.value, { evidence: () => [] }),
      },
    };

    const result = await wrapTool(resultPublishSpec(services), services).execute(
      { report: { title: 'Done' } },
      undefined,
    );

    expect(result.error_code).toBe('CONTRACT_REQUIRED');
    expect(await exists(join(runDir, 'document.json'))).toBe(false);
  });
});
