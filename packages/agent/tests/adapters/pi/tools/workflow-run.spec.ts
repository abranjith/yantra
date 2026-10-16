// @no-llm
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DefaultSanitizer, type WorkflowCatalogEntry } from '@yantra/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { workflowRunSpec } from '../../../../src/adapters/pi/tools/workflow-run.js';
import { wrapTool } from '../../../../src/runtime/middleware.js';
import type {
  WorkflowRunToolOutcome,
  WorkflowToolDeps,
} from '../../../../src/runtime/run-services.js';
import { TaskContractStore, normalizeContract } from '../../../../src/runtime/task-contract.js';

import { assertToolContract, buildServices } from './test-support.js';

const catalog: WorkflowCatalogEntry[] = [
  {
    name: 'bank-statement',
    description: 'Download the monthly statement',
    params: [
      { name: 'month', type: 'string', required: true },
      { name: 'count', type: 'number', required: false },
    ],
    hosts: ['bank.example'],
  },
];

function workflowServices(
  overrides: Partial<WorkflowToolDeps> = {},
): ReturnType<typeof buildServices> {
  const deps: WorkflowToolDeps = {
    listCatalog: () => Promise.resolve(catalog),
    run: () =>
      Promise.resolve<WorkflowRunToolOutcome>({
        ok: true,
        runId: 'nested-run-1',
        stepCount: 3,
        outputs: {},
      }),
    ...overrides,
  };
  return buildServices({ domain: { workflow: deps } });
}

describe('@no-llm workflow_run tool', () => {
  it('passes the reusable tool contract harness', async () => {
    await assertToolContract(workflowRunSpec(workflowServices()), { mode: 'invalid' });
  });

  it('lists the secret-free catalog in list mode', async () => {
    const services = workflowServices();
    const result = await wrapTool(workflowRunSpec(services), services).execute(
      { mode: 'list' },
      undefined,
    );
    expect(result.status).toBe('ok');
    expect(result.modelText).toContain('bank-statement');
    expect(result.modelText).toContain('bank.example');
  });

  it('returns WORKFLOW_NOT_FOUND for an unknown workflow', async () => {
    const services = workflowServices();
    const result = await wrapTool(workflowRunSpec(services), services).execute(
      { mode: 'run', workflow: 'no-such-flow' },
      undefined,
    );
    expect(result.error_code).toBe('WORKFLOW_NOT_FOUND');
  });

  it('returns a param validation error naming the offending param', async () => {
    const services = workflowServices();
    const result = await wrapTool(workflowRunSpec(services), services).execute(
      { mode: 'run', workflow: 'bank-statement', params: { month: '2026-04', count: 'ten' } },
      undefined,
    );
    expect(result.error_code).toBe('WORKFLOW_PARAM_INVALID');
    expect(result.modelText).toContain('count');
  });

  it('requires the required param', async () => {
    const services = workflowServices();
    const result = await wrapTool(workflowRunSpec(services), services).execute(
      { mode: 'run', workflow: 'bank-statement', params: {} },
      undefined,
    );
    expect(result.error_code).toBe('WORKFLOW_PARAM_INVALID');
    expect(result.modelText).toContain('month');
  });

  it('runs a workflow and returns the nested run id and step count', async () => {
    const run = vi.fn().mockResolvedValue({
      ok: true,
      runId: 'nested-run-42',
      stepCount: 4,
      outputs: { balance: '100.00' },
    } satisfies WorkflowRunToolOutcome);
    const services = workflowServices({ run });
    const result = await wrapTool(workflowRunSpec(services), services).execute(
      { mode: 'run', workflow: 'bank-statement', params: { month: '2026-04' } },
      undefined,
    );
    expect(result.status).toBe('ok');
    expect(result.modelText).toContain('nested-run-42');
    // The parent audit records the nested run id via details.
    expect(result.details).toMatchObject({ nested_run_id: 'nested-run-42' });
    // Only declared params reach the executor.
    expect(run).toHaveBeenCalledWith(
      { workflow: 'bank-statement', params: { month: '2026-04' } },
      expect.objectContaining({ confirmationGateway: null }),
    );
  });

  it('surfaces a nested run failure as a structured, non-retryable result (no crash)', async () => {
    const services = workflowServices({
      run: () =>
        Promise.resolve<WorkflowRunToolOutcome>({
          ok: false,
          errorCode: 'WORKFLOW_RUN_FAILED',
          message: 'The workflow run failed (locator_not_found).',
          runId: 'nested-run-err',
          retryable: false,
        }),
    });
    const result = await wrapTool(workflowRunSpec(services), services).execute(
      { mode: 'run', workflow: 'bank-statement', params: { month: '2026-04' } },
      undefined,
    );
    expect(result.status).toBe('error');
    expect(result.error_code).toBe('WORKFLOW_RUN_FAILED');
    expect(result.retryable).toBe(false);
    expect(result.details).toMatchObject({ nested_run_id: 'nested-run-err' });
  });

  it('sanitizes a credential-shaped value in the outputs summary (canary)', async () => {
    const services = workflowServices({
      run: () =>
        Promise.resolve<WorkflowRunToolOutcome>({
          ok: true,
          runId: 'nested-run-canary',
          stepCount: 1,
          outputs: { leaked: 'sk-CANARYtokenABCDEFGHIJKLMNOP' },
        }),
    });
    const result = await wrapTool(workflowRunSpec(services), services).execute(
      { mode: 'run', workflow: 'bank-statement', params: { month: '2026-04' } },
      undefined,
    );
    expect(result.status).toBe('ok');
    expect(result.modelText).not.toContain('sk-CANARYtokenABCDEFGHIJKLMNOP');
  });

  it('fails closed when workflow deps are not configured', async () => {
    const services = buildServices({ domain: { workflow: null } });
    const result = await wrapTool(workflowRunSpec(services), services).execute(
      { mode: 'run', workflow: 'bank-statement', params: { month: '2026-04' } },
      undefined,
    );
    expect(result.error_code).toBe('WORKFLOW_UNAVAILABLE');
  });
});

describe('@no-llm workflow_run under effects.submit: forbidden (FEAT-054 S8)', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function forbiddingServices(
    overrides: Partial<WorkflowToolDeps>,
  ): Promise<ReturnType<typeof buildServices>> {
    const dir = await mkdtemp(join(tmpdir(), 'yantra-workflow-submit-'));
    dirs.push(dir);
    const contract = new TaskContractStore({
      runId: 'r',
      runDir: dir,
      command: 'do',
      required: true,
    });
    const body = normalizeContract(
      { deliverable: 'actions', subject: 'the statement', effects: { submit: 'forbidden' } },
      { sanitizer: new DefaultSanitizer() },
    );
    if (!body.isOk) throw new Error('fixture rejected');
    await contract.declare(body.value, '2026-10-15T12:00:00.000Z');
    const deps: WorkflowToolDeps = {
      listCatalog: () => Promise.resolve(catalog),
      run: () =>
        Promise.resolve<WorkflowRunToolOutcome>({
          ok: true,
          runId: 'nested-run-1',
          stepCount: 2,
          outputs: {},
        }),
      ...overrides,
    };
    return buildServices({ runDir: dir, contract, domain: { workflow: deps } });
  }

  const RUN = { mode: 'run', workflow: 'bank-statement', params: { month: '2026-04' } } as const;

  it('refuses a workflow with a click step before it runs', async () => {
    const run = vi.fn();
    const services = await forbiddingServices({
      run,
      loadSteps: () => Promise.resolve([{ verb: 'navigate' }, { verb: 'click' }]),
    });

    const result = await wrapTool(workflowRunSpec(services), services).execute(RUN, undefined);

    expect(result.error_code).toBe('SUBMIT_FORBIDDEN');
    expect((JSON.parse(result.modelText) as { message: string }).message).toMatch(
      /workflow "bank-statement" clicks/u,
    );
    expect(run).not.toHaveBeenCalled();
  });

  it('refuses a workflow that calls a clicking workflow', async () => {
    const run = vi.fn();
    const plans: Record<string, readonly { verb: string; workflow_name?: string }[]> = {
      'bank-statement': [{ verb: 'call_workflow', workflow_name: 'login' }],
      login: [{ verb: 'fill_element' }, { verb: 'click' }],
    };
    const services = await forbiddingServices({
      run,
      loadSteps: (name) => Promise.resolve(plans[name] ?? null),
    });

    const result = await wrapTool(workflowRunSpec(services), services).execute(RUN, undefined);

    expect(result.error_code).toBe('SUBMIT_FORBIDDEN');
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    ['the plan cannot be loaded', () => Promise.resolve(null)],
    ['plan loading is not wired', undefined],
  ])('fails closed when %s', async (_label, loadSteps) => {
    const run = vi.fn();
    const services = await forbiddingServices({
      run,
      ...(loadSteps === undefined ? {} : { loadSteps }),
    });

    const result = await wrapTool(workflowRunSpec(services), services).execute(RUN, undefined);

    expect(result.error_code).toBe('SUBMIT_FORBIDDEN');
    expect(run).not.toHaveBeenCalled();
  });

  it('runs an extract-only workflow, and a cycle of calls terminates', async () => {
    const run = vi.fn().mockResolvedValue({
      ok: true,
      runId: 'nested-run-1',
      stepCount: 2,
      outputs: {},
    });
    const plans: Record<string, readonly { verb: string; workflow_name?: string }[]> = {
      'bank-statement': [
        { verb: 'navigate' },
        { verb: 'extract' },
        { verb: 'call_workflow', workflow_name: 'helper' },
      ],
      helper: [{ verb: 'call_workflow', workflow_name: 'bank-statement' }],
    };
    const services = await forbiddingServices({
      run,
      loadSteps: (name) => Promise.resolve(plans[name] ?? null),
    });

    const result = await wrapTool(workflowRunSpec(services), services).execute(RUN, undefined);

    expect(result.status).toBe('ok');
    expect(run).toHaveBeenCalledOnce();
  });

  it('never loads the plan when submitting is allowed', async () => {
    const loadSteps = vi.fn();
    const services = workflowServices({ loadSteps });

    const result = await wrapTool(workflowRunSpec(services), services).execute(RUN, undefined);

    expect(result.status).toBe('ok');
    expect(loadSteps).not.toHaveBeenCalled();
  });
});
