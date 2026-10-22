import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseTemplate } from '@yantra/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { browserFillElementSpec } from '../../../../src/adapters/pi/tools/browser-fill-element.js';
import { browserFillFormSpec } from '../../../../src/adapters/pi/tools/browser-fill-form.js';
import { browserNavigateSpec } from '../../../../src/adapters/pi/tools/browser-navigate.js';
import { browserObserveSpec } from '../../../../src/adapters/pi/tools/browser-observe.js';
import {
  createBriefPublisher,
  createTemplatedReportPublisher,
  resultPublishSpec,
} from '../../../../src/adapters/pi/tools/result-publish.js';
import { taskContractSpec } from '../../../../src/adapters/pi/tools/task-contract.js';
import { workflowRunSpec } from '../../../../src/adapters/pi/tools/workflow-run.js';
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

describe('@no-llm page-changing tools wait for the contract in do (REV-003)', () => {
  let runDir: string;
  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'yantra-contract-first-'));
  });
  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  function setup(command: AgenticCommand) {
    const contract = new TaskContractStore({
      runId: 'r',
      runDir,
      command,
      required: command !== 'ask',
      requiredToPublish: command === 'do',
    });
    const services = buildServices({ runDir, contract });
    return { services, declare: wrapTool(taskContractSpec(services), services) };
  }

  const FILL_FORM = { fields: [{ field: 'First name', value: 'Ada' }] };
  const FILL_ELEMENT = { field: 'First name', value: 'Ada' };
  const RUN_WORKFLOW = { mode: 'run', workflow: 'sign-up' } as const;

  it.each([
    ['browser_fill_form', browserFillFormSpec, FILL_FORM],
    ['browser_fill_element', browserFillElementSpec, FILL_ELEMENT],
    ['workflow_run (mode run)', workflowRunSpec, RUN_WORKFLOW],
  ] as const)(
    'refuses %s before a contract and names task_contract',
    async (_label, spec, input) => {
      const { services } = setup('do');

      const result = await wrapTool(spec(services) as never, services).execute(input, undefined);

      expect(result.error_code).toBe('CONTRACT_REQUIRED');
      expect(result.retryable).toBe(true);
      expect(result.modelText).toMatch(/Call task_contract first/u);
    },
  );

  it.each([
    ['browser_navigate', browserNavigateSpec, { url: 'https://forms.example.test/' }],
    ['browser_observe', browserObserveSpec, {}],
    ['workflow_run (mode list)', workflowRunSpec, { mode: 'list' }],
  ] as const)(
    'leaves %s open before a contract: reading needs none',
    async (_label, spec, input) => {
      const { services } = setup('do');

      const result = await wrapTool(spec(services) as never, services).execute(input, undefined);

      expect(result.error_code).not.toBe('CONTRACT_REQUIRED');
    },
  );

  it('lets the same fill through once a contract is declared', async () => {
    const { services, declare } = setup('do');
    const fill = wrapTool(browserFillFormSpec(services), services);
    expect((await fill.execute(FILL_FORM, undefined)).error_code).toBe('CONTRACT_REQUIRED');

    expect((await declare.execute(CONTRACT, undefined)).status).toBe('ok');
    const result = await fill.execute(FILL_FORM, undefined);

    // No browser in this fixture: the call now reaches the tool body.
    expect(result.error_code).not.toBe('CONTRACT_REQUIRED');
  });

  it.each(['research', 'ask'] as const)('does not gate %s', async (command) => {
    const { services } = setup(command);

    const result = await wrapTool(browserFillFormSpec(services), services).execute(
      FILL_FORM,
      undefined,
    );

    expect(result.error_code).not.toBe('CONTRACT_REQUIRED');
  });
});
