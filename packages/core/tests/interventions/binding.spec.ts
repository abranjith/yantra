// @no-llm
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ConfirmationRequest, Plan, Step, TaskEvent } from '@yantra/protocol';
import { SCHEMA_VERSION } from '@yantra/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InMemoryCaptureStore } from '../../src/executor/capture-store.js';
import { Executor } from '../../src/executor/executor.js';
import { RetryBudgetImpl } from '../../src/executor/retry-budget.js';
import type { EventBus, ExecutionContext } from '../../src/executor/types.js';
import {
  bindingOf,
  bindingsMatch,
  canonicalJson,
  computeConfirmationBinding,
  normalizeTargetHost,
} from '../../src/interventions/index.js';

function makePlan(steps: Step[]): Plan {
  return {
    task_id: 'task-binding-test',
    plan_id: 'plan-binding-test',
    schema_version: SCHEMA_VERSION,
    default_scope: 'public',
    steps,
    outputs: [],
  };
}

function makeNavigateStep(id: string, url: string, requiresConfirmation = false): Step {
  return {
    id,
    scope: null,
    requires_confirmation: requiresConfirmation,
    confirmation_description: null,
    expected_cost: null,
    consequence: null,
    type: 'navigate',
    url: { kind: 'literal', value: url },
  } as Step;
}

function makeFillStep(id: string, locatorName: string): Step {
  return {
    id,
    scope: null,
    requires_confirmation: true,
    confirmation_description: 'Fill sensitive field',
    expected_cost: null,
    consequence: 'hard_to_reverse',
    type: 'fill',
    locator: { kind: 'workflow', name: locatorName },
    value: { kind: 'param', key: 'secret_note' },
    clear: true,
  } as Step;
}

describe('@no-llm action binding (FEAT-068 TASK-003)', () => {
  it('produces the same plan_digest regardless of object key order', () => {
    const stepA = makeNavigateStep('s1', 'https://shop.example/cart', true);
    const planA: Plan = {
      task_id: 'task-1',
      plan_id: 'plan-1',
      schema_version: SCHEMA_VERSION,
      default_scope: 'public',
      steps: [stepA],
      outputs: [],
    };
    const planB = {
      outputs: [],
      steps: [
        {
          url: { value: 'https://shop.example/cart', kind: 'literal' },
          type: 'navigate',
          consequence: null,
          expected_cost: null,
          confirmation_description: null,
          requires_confirmation: true,
          scope: null,
          id: 's1',
        } as unknown as Step,
      ],
      default_scope: 'public',
      schema_version: SCHEMA_VERSION,
      plan_id: 'plan-1',
      task_id: 'task-1',
    } as unknown as Plan;

    const bindingA = computeConfirmationBinding(planA, stepA, 'https://shop.example/cart');
    const bindingB = computeConfirmationBinding(
      planB,
      planB.steps[0]!,
      'https://shop.example/cart',
    );

    expect(bindingA.plan_digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(bindingA.plan_digest).toBe(bindingB.plan_digest);
    expect(bindingA.step_digest).toBe(bindingB.step_digest);
  });

  it("changes plan_digest and that step's step_digest when a locator changes, leaving other steps unchanged", () => {
    const s1 = makeFillStep('s1', 'Email');
    const s2 = makeFillStep('s2', 'Submit');
    const planBefore = makePlan([s1, s2]);

    const s1Modified = makeFillStep('s1', 'DifferentEmail');
    const planAfter = makePlan([s1Modified, s2]);

    const beforeS1 = computeConfirmationBinding(planBefore, s1, 'https://shop.example');
    const beforeS2 = computeConfirmationBinding(planBefore, s2, 'https://shop.example');
    const afterS1 = computeConfirmationBinding(planAfter, s1Modified, 'https://shop.example');
    const afterS2 = computeConfirmationBinding(planAfter, s2, 'https://shop.example');

    expect(afterS1.plan_digest).not.toBe(beforeS1.plan_digest);
    expect(afterS1.step_digest).not.toBe(beforeS1.step_digest);
    expect(afterS2.step_digest).toBe(beforeS2.step_digest);
  });

  it('never includes resolved parameter values in canonical plan/step digests', () => {
    const step = makeFillStep('s1', 'NoteInput');
    const plan = makePlan([step]);
    const canaryParamValue = 'CANARY_PARAM_VALUE_DO_NOT_HASH';

    const planText = canonicalJson(plan);
    const stepText = canonicalJson(step);
    expect(planText).not.toContain(canaryParamValue);
    expect(stepText).not.toContain(canaryParamValue);

    const b1 = computeConfirmationBinding(plan, step, 'https://shop.example/form');
    const b2 = computeConfirmationBinding(plan, step, 'https://shop.example/form');
    expect(b1).toEqual(b2);
  });

  it('lowercases target_host and strips the port', () => {
    expect(normalizeTargetHost('https://Shop.Example.COM:8443/checkout?x=1')).toBe(
      'shop.example.com',
    );
    expect(normalizeTargetHost('API.Example.NET:9000')).toBe('api.example.net');
    expect(normalizeTargetHost('https://[::1]:8080/path')).toBe('[::1]');
    expect(normalizeTargetHost('unknown')).toBeNull();
    expect(normalizeTargetHost('about:blank')).toBeNull();
    expect(normalizeTargetHost(null)).toBeNull();
  });

  it('bindingsMatch returns false on any single-field difference or null target_host', () => {
    const base = {
      run_id: 'run-1',
      step_id: 's1',
      action_kind: 'click' as const,
      target_host: 'shop.example',
      plan_digest: 'a'.repeat(64),
      step_digest: 'b'.repeat(64),
    };

    expect(bindingsMatch(base, { ...base })).toBe(true);
    expect(bindingsMatch(base, { ...base, run_id: 'run-2' })).toBe(false);
    expect(bindingsMatch(base, { ...base, step_id: 's2' })).toBe(false);
    expect(bindingsMatch(base, { ...base, action_kind: 'fill' })).toBe(false);
    expect(bindingsMatch(base, { ...base, target_host: 'other.example' })).toBe(false);
    expect(bindingsMatch(base, { ...base, target_host: null })).toBe(false);
    expect(bindingsMatch({ ...base, target_host: null }, base)).toBe(false);
    expect(bindingsMatch({ ...base, target_host: null }, { ...base, target_host: null })).toBe(
      false,
    );
    expect(bindingsMatch(base, { ...base, plan_digest: 'c'.repeat(64) })).toBe(false);
    expect(bindingsMatch(base, { ...base, step_digest: 'd'.repeat(64) })).toBe(false);
    expect(bindingsMatch(base, { ...base, plan_digest: null })).toBe(false);
    expect(bindingsMatch(base, { ...base, step_digest: null })).toBe(false);

    // Agentic requests omit both digests on both sides
    const agentic = { ...base, plan_digest: null, step_digest: null };
    expect(bindingsMatch(agentic, { ...agentic })).toBe(true);
    expect(bindingsMatch(agentic, base)).toBe(false);
  });

  it('extracts bindingOf from a ConfirmationRequest', () => {
    const req: ConfirmationRequest = {
      confirmation_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      run_id: 'run-1',
      step_id: 's1',
      action_kind: 'navigate',
      host: 'Shop.Example:8443',
      description: 'Go to checkout',
      expected_cost: null,
      consequence: 'reversible',
      requested_at: '2026-11-03T12:00:00.000Z',
      timeout_ms: null,
      target_host: 'shop.example',
      plan_digest: 'a'.repeat(64),
      step_digest: 'b'.repeat(64),
    };
    expect(bindingOf(req)).toEqual({
      run_id: 'run-1',
      step_id: 's1',
      action_kind: 'navigate',
      target_host: 'shop.example',
      plan_digest: 'a'.repeat(64),
      step_digest: 'b'.repeat(64),
    });
  });
});

describe('@no-llm executor confirmation checkpoint emits binding fields', () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'yantra-exec-binding-'));
  });

  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  it('populates target_host, plan_digest, and step_digest on confirmation_requested events', async () => {
    const step = makeNavigateStep('s1', 'https://Shop.Example:8443/pay', true);
    const plan = makePlan([step]);
    const events: TaskEvent[] = [];
    const bus: EventBus = {
      publish: (e) => events.push(e),
      flush: () => Promise.resolve(),
      persistedAt: () => '',
      close: () => Promise.resolve(),
    };
    const ctx: ExecutionContext = {
      runId: 'run-exec-bind',
      taskId: 'task-binding-test',
      plan,
      currentStepIdx: 0,
      captures: new InMemoryCaptureStore(),
      secrets: null,
      sanitizer: null,
      llmClient: null,
      workflowLocators: null,
      browser: null,
      page: null,
      locatorHost: null,
      events: bus,
      budgets: new RetryBudgetImpl({}, { taskId: 'task-binding-test', runId: 'run-exec-bind' }),
      checkpointStore: {
        save: () => Promise.resolve(),
        load: () => Promise.resolve(null),
        list: () => Promise.resolve([]),
        loadLast: () => Promise.resolve(null),
      },
      ethics: { check: () => Promise.resolve() },
      confirmationGateway: {
        request: (req) =>
          Promise.resolve({
            confirmation_id: req.confirmation_id,
            decision: 'denied',
            decided_at: '2026-11-03T12:00:01.000Z',
            decided_by: 'user_interactive',
          }),
      },
      confirmationStore: null,
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        debug: () => undefined,
      },
      runDir,
      scopeChain: ['public'],
    };

    const executor = new Executor();
    await executor.run(ctx);

    const requested = events.find(
      (e): e is Extract<TaskEvent, { kind: 'confirmation_requested' }> =>
        e.kind === 'confirmation_requested',
    );
    expect(requested).toBeDefined();
    const expected = computeConfirmationBinding(plan, step, 'https://Shop.Example:8443/pay');
    expect(requested!.request.target_host).toBe('shop.example');
    expect(requested!.request.plan_digest).toBe(expected.plan_digest);
    expect(requested!.request.step_digest).toBe(expected.step_digest);
  });
});
