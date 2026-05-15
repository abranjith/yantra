import { describe, expect, it, vi } from 'vitest';

import { handleBranch } from '../../../src/executor/step-handlers/branch.js';
import { InMemoryCaptureStore } from '../../../src/executor/capture-store.js';
import type { ExecutionContext } from '../../../src/executor/types.js';

const makeCtx = (captures: Record<string, unknown> = {}): ExecutionContext => {
  const store = new InMemoryCaptureStore();
  for (const [k, v] of Object.entries(captures)) store.set(k, v);
  return {
    runId: 'run-1',
    taskId: 'task-1',
    plan: { schema_version: '0.1', plan_id: 'p1', task_id: 'task-1', default_scope: 'public', steps: [] },
    currentStepIdx: 0,
    captures: store,
    secrets: null,
    sanitizer: null,
    llmClient: null,
    workflowLocators: null,
    browser: null,
    page: null,
    locatorHost: null,
    events: { publish: vi.fn(), flush: vi.fn().mockResolvedValue(undefined), persistedAt: vi.fn().mockReturnValue(null), close: vi.fn().mockResolvedValue(undefined) },
    budgets: { canRetry: vi.fn(), consume: vi.fn(), initial: vi.fn(), remaining: vi.fn(), snapshot: vi.fn(), clone: vi.fn() },
    ethics: { check: vi.fn().mockResolvedValue(undefined) },
    checkpoints: { save: vi.fn(), load: vi.fn(), list: vi.fn(), loadLast: vi.fn() },
    scopeChain: ['public'],
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    clock: { now: () => 0, setTimeout: vi.fn(), clearTimeout: vi.fn() },
    runDir: '/tmp/run-1',
  };
};

describe('@no-llm handleBranch', () => {
  it('always condition jumps to then_step_id', async () => {
    const step = {
      type: 'branch' as const,
      id: 's1',
      scope: 'public' as const,
      condition: { kind: 'always' as const },
      then_step_id: 's2',
      else_step_id: null,
    };
    const result = await handleBranch(step, makeCtx());
    expect(result.kind).toBe('jump');
    if (result.kind === 'jump') expect(result.toStepId).toBe('s2');
  });

  it('capture_exists jumps to then_step_id when capture is present', async () => {
    const step = {
      type: 'branch' as const,
      id: 's1',
      scope: 'public' as const,
      condition: {
        kind: 'capture_exists' as const,
        capture: { kind: 'capture' as const, step_id: 's0', field: null },
      },
      then_step_id: 's2',
      else_step_id: 's3',
    };
    const ctx = makeCtx({ s0: 'some value' });
    const result = await handleBranch(step, ctx);
    expect(result.kind).toBe('jump');
    if (result.kind === 'jump') expect(result.toStepId).toBe('s2');
  });

  it('capture_exists jumps to else_step_id when capture is absent', async () => {
    const step = {
      type: 'branch' as const,
      id: 's1',
      scope: 'public' as const,
      condition: {
        kind: 'capture_exists' as const,
        capture: { kind: 'capture' as const, step_id: 's99', field: null },
      },
      then_step_id: 's2',
      else_step_id: 's3',
    };
    const result = await handleBranch(step, makeCtx());
    expect(result.kind).toBe('jump');
    if (result.kind === 'jump') expect(result.toStepId).toBe('s3');
  });

  it('capture_exists with null else_step_id returns completed when condition is false', async () => {
    const step = {
      type: 'branch' as const,
      id: 's1',
      scope: 'public' as const,
      condition: {
        kind: 'capture_exists' as const,
        capture: { kind: 'capture' as const, step_id: 's99', field: null },
      },
      then_step_id: 's2',
      else_step_id: null,
    };
    const result = await handleBranch(step, makeCtx());
    expect(result.kind).toBe('completed');
  });

  it('capture_exists with field checks field presence on the capture object', async () => {
    const step = {
      type: 'branch' as const,
      id: 's1',
      scope: 'public' as const,
      condition: {
        kind: 'capture_exists' as const,
        capture: { kind: 'capture' as const, step_id: 's0', field: 'email' },
      },
      then_step_id: 's2',
      else_step_id: 's3',
    };

    // Field present → then branch
    const ctxWithField = makeCtx({ s0: { email: 'a@b.com' } });
    const resultWith = await handleBranch(step, ctxWithField);
    expect(resultWith.kind).toBe('jump');
    if (resultWith.kind === 'jump') expect(resultWith.toStepId).toBe('s2');

    // Field absent → else branch
    const ctxWithoutField = makeCtx({ s0: { name: 'Alice' } });
    const resultWithout = await handleBranch(step, ctxWithoutField);
    expect(resultWithout.kind).toBe('jump');
    if (resultWithout.kind === 'jump') expect(resultWithout.toStepId).toBe('s3');
  });
});
