// @no-llm
import type { WorkflowCatalogEntry } from '@yantra/core';
import { describe, expect, it, vi } from 'vitest';

import { workflowRunSpec } from '../../../../src/adapters/pi/tools/workflow-run.js';
import { wrapTool } from '../../../../src/runtime/middleware.js';
import type {
  WorkflowRunToolOutcome,
  WorkflowToolDeps,
} from '../../../../src/runtime/run-services.js';

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
