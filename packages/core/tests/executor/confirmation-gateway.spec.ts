// @no-llm
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  ConfirmationDecision,
  ConfirmationRequest,
  Plan,
  Step,
  TaskEvent,
} from '@yantra/protocol';
import { SCHEMA_VERSION } from '@yantra/protocol';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { InMemoryCaptureStore } from '../../src/executor/capture-store.js';
import {
  type ConfirmationStore,
  createConfirmationStore,
} from '../../src/executor/confirmation-gateway.js';
import type { ConfirmationGateway } from '../../src/executor/confirmation-gateway.js';
import { Executor } from '../../src/executor/executor.js';
import { RetryBudgetImpl } from '../../src/executor/retry-budget.js';
import type { EventBus, ExecutionContext } from '../../src/executor/types.js';

class FakeEventBus implements EventBus {
  readonly events: TaskEvent[] = [];
  private closed = false;
  publish(event: TaskEvent): void {
    if (!this.closed) this.events.push(event);
  }
  flush(): Promise<void> {
    return Promise.resolve();
  }
  persistedAt(): string {
    return '';
  }
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

class FakeConfirmationGateway implements ConfirmationGateway {
  public lastRequest: ConfirmationRequest | null = null;
  public callCount = 0;
  constructor(
    private readonly decisionFn: (req: ConfirmationRequest) => ConfirmationDecision,
    private readonly shouldThrow = false,
  ) {}
  async request(request: ConfirmationRequest): Promise<ConfirmationDecision> {
    this.lastRequest = request;
    this.callCount++;
    if (this.shouldThrow) throw new Error('Gateway transport failure');
    return this.decisionFn(request);
  }
}

const noop = (): void => undefined;
const fakeLogger = { info: noop, warn: noop, error: noop, debug: noop } as const;

function makePlan(steps: Step[]): Plan {
  return {
    task_id: 'task-test',
    plan_id: 'plan-test',
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

function makeClickStep(id: string, requiresConfirmation = false): Step {
  return {
    id,
    scope: null,
    requires_confirmation: requiresConfirmation,
    confirmation_description: null,
    expected_cost: null,
    consequence: null,
    type: 'click',
    locator: { kind: 'workflow', name: 'Button' },
    modifiers: null,
  } as Step;
}

function makeContext(
  plan: Plan,
  runDir: string,
  gateway: ConfirmationGateway | null,
  store: ConfirmationStore | null,
): ExecutionContext {
  return {
    runId: 'run-test',
    taskId: 'task-test',
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
    events: new FakeEventBus(),
    budgets: new RetryBudgetImpl({}, { taskId: 'task-test', runId: 'run-test' }),
    ethics: { check: () => Promise.resolve() },
    checkpoints: {
      save: () => Promise.resolve(),
      load: () => Promise.resolve(null),
      list: () => Promise.resolve([]),
      loadLast: () => Promise.resolve(null),
    },
    scopeChain: [],
    logger: fakeLogger as never,
    clock: {
      now: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h),
    },
    runDir,
    confirmationGateway: gateway,
    confirmationStore: store,
  };
}

describe('ConfirmationStore', () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'yantra-confirm-'));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('appends and reads back a request', async () => {
    const store = createConfirmationStore(tmpDir);
    const req: ConfirmationRequest = {
      confirmation_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      run_id: 'run-1',
      step_id: 's1',
      action_kind: 'click',
      host: 'example.com',
      description: 'Click button',
      expected_cost: null,
      consequence: 'unknown',
      requested_at: '2026-07-01T00:00:00.000Z',
      timeout_ms: null,
    };
    await store.appendRequest(req);
    const entries = await store.readAll();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe('request');
  });

  it('appends and reads back a decision', async () => {
    const store = createConfirmationStore(tmpDir);
    const req: ConfirmationRequest = {
      confirmation_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      run_id: 'run-1',
      step_id: 's1',
      action_kind: 'click',
      host: 'example.com',
      description: 'Click button',
      expected_cost: null,
      consequence: 'unknown',
      requested_at: '2026-07-01T00:00:00.000Z',
      timeout_ms: null,
    };
    const decision: ConfirmationDecision = {
      confirmation_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      decision: 'granted',
      decided_at: '2026-07-01T00:00:01.000Z',
      decided_by: 'user_interactive',
    };
    await store.appendRequest(req);
    await store.appendDecision(decision);
    const entries = await store.readAll();
    expect(entries).toHaveLength(2);
    expect(entries[0]?.kind).toBe('request');
    expect(entries[1]?.kind).toBe('decision');
  });

  it('finds a pending request (no decision)', async () => {
    const store = createConfirmationStore(tmpDir);
    const req: ConfirmationRequest = {
      confirmation_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      run_id: 'run-1',
      step_id: 's1',
      action_kind: 'click',
      host: 'example.com',
      description: 'Click button',
      expected_cost: null,
      consequence: 'unknown',
      requested_at: '2026-07-01T00:00:00.000Z',
      timeout_ms: null,
    };
    await store.appendRequest(req);
    const pending = await store.findPending('run-1');
    expect(pending).not.toBeNull();
    expect(pending?.confirmation_id).toBe('01ARZ3NDEKTSV4RRFFQ69G5FAV');
  });

  it('returns null when request has a matching decision', async () => {
    const store = createConfirmationStore(tmpDir);
    const req: ConfirmationRequest = {
      confirmation_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      run_id: 'run-1',
      step_id: 's1',
      action_kind: 'click',
      host: 'example.com',
      description: 'Click button',
      expected_cost: null,
      consequence: 'unknown',
      requested_at: '2026-07-01T00:00:00.000Z',
      timeout_ms: null,
    };
    const decision: ConfirmationDecision = {
      confirmation_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      decision: 'granted',
      decided_at: '2026-07-01T00:00:01.000Z',
      decided_by: 'user_interactive',
    };
    await store.appendRequest(req);
    await store.appendDecision(decision);
    const pending = await store.findPending('run-1');
    expect(pending).toBeNull();
  });

  it('detects double-resolution via hasDecision', async () => {
    const store = createConfirmationStore(tmpDir);
    const id = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    const decision: ConfirmationDecision = {
      confirmation_id: id,
      decision: 'granted',
      decided_at: '2026-07-01T00:00:01.000Z',
      decided_by: 'user_interactive',
    };
    await store.appendDecision(decision);
    expect(await store.hasDecision(id)).toBe(true);
    expect(await store.hasDecision('OTHER_ID')).toBe(false);
  });

  it('returns empty array when file does not exist', async () => {
    const store = createConfirmationStore(tmpDir);
    const entries = await store.readAll();
    expect(entries).toEqual([]);
  });
});

describe('Executor confirmation checkpoint', () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'yantra-exec-'));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('flagged step blocks until fake gateway grants, then executes exactly once', async () => {
    const gateway = new FakeConfirmationGateway(() => ({
      confirmation_id: '',
      decision: 'granted',
      decided_at: '2026-07-01T00:00:01.000Z',
      decided_by: 'user_interactive',
    }));
    const store = createConfirmationStore(tmpDir);
    const plan = makePlan([makeNavigateStep('s1', 'https://example.com', true)]);
    const ctx = makeContext(plan, tmpDir, gateway, store);
    const executor = new Executor();
    await executor.run(ctx);
    expect(gateway.callCount).toBe(1);
    expect(gateway.lastRequest).not.toBeNull();
    expect(gateway.lastRequest?.step_id).toBe('s1');
    expect(gateway.lastRequest?.action_kind).toBe('navigate');
    const events = (ctx.events as FakeEventBus).events;
    const requested = events.find((e) => e.kind === 'confirmation_requested');
    expect(requested).toBeDefined();
    const resolved = events.find((e) => e.kind === 'confirmation_resolved');
    expect(resolved).toBeDefined();
  });

  it('deny aborts with handoff outcome and correct event sequence', async () => {
    const gateway = new FakeConfirmationGateway(() => ({
      confirmation_id: '',
      decision: 'denied',
      decided_at: '2026-07-01T00:00:01.000Z',
      decided_by: 'user_interactive',
    }));
    const store = createConfirmationStore(tmpDir);
    const plan = makePlan([makeNavigateStep('s1', 'https://example.com', true)]);
    const ctx = makeContext(plan, tmpDir, gateway, store);
    const executor = new Executor();
    const outcome = await executor.run(ctx);
    expect(outcome.status).toBe('handoff');
    expect(gateway.callCount).toBe(1);
    const events = (ctx.events as FakeEventBus).events;
    const requested = events.find((e) => e.kind === 'confirmation_requested');
    expect(requested).toBeDefined();
    const resolved = events.find((e) => e.kind === 'confirmation_resolved');
    expect(resolved).toBeDefined();
    if (resolved && resolved.kind === 'confirmation_resolved') {
      expect(resolved.decision).toBe('denied');
    }
    const handoff = events.find((e) => e.kind === 'human_handoff_requested');
    expect(handoff).toBeDefined();
  });

  it('timed_out behaves as deny (handoff abort)', async () => {
    const gateway = new FakeConfirmationGateway(() => ({
      confirmation_id: '',
      decision: 'timed_out',
      decided_at: '2026-07-01T00:00:01.000Z',
      decided_by: 'timeout',
    }));
    const store = createConfirmationStore(tmpDir);
    const plan = makePlan([makeClickStep('s1', true)]);
    const ctx = makeContext(plan, tmpDir, gateway, store);
    const executor = new Executor();
    const outcome = await executor.run(ctx);
    expect(outcome.status).toBe('handoff');
  });

  it('unflagged steps are unaffected (no gateway call)', async () => {
    const gateway = new FakeConfirmationGateway(() => ({
      confirmation_id: '',
      decision: 'granted',
      decided_at: '2026-07-01T00:00:01.000Z',
      decided_by: 'user_interactive',
    }));
    const store = createConfirmationStore(tmpDir);
    const plan = makePlan([makeNavigateStep('s1', 'https://example.com')]);
    const ctx = makeContext(plan, tmpDir, gateway, store);
    const executor = new Executor();
    await executor.run(ctx);
    expect(gateway.callCount).toBe(0);
    const events = (ctx.events as FakeEventBus).events;
    const requested = events.find((e) => e.kind === 'confirmation_requested');
    expect(requested).toBeUndefined();
  });

  it('no-gateway + flagged step = fail-closed abort', async () => {
    const store = createConfirmationStore(tmpDir);
    const plan = makePlan([makeClickStep('s1', true)]);
    const ctx = makeContext(plan, tmpDir, null, store);
    const executor = new Executor();
    const outcome = await executor.run(ctx);
    expect(outcome.status).toBe('handoff');
    const events = (ctx.events as FakeEventBus).events;
    const requested = events.find((e) => e.kind === 'confirmation_requested');
    expect(requested).toBeUndefined();
  });

  it('gateway transport failure is treated as deny (fail-closed)', async () => {
    const gateway = new FakeConfirmationGateway(
      () => ({
        confirmation_id: '',
        decision: 'granted',
        decided_at: '2026-07-01T00:00:01.000Z',
        decided_by: 'user_interactive',
      }),
      true,
    );
    const store = createConfirmationStore(tmpDir);
    const plan = makePlan([makeClickStep('s1', true)]);
    const ctx = makeContext(plan, tmpDir, gateway, store);
    const executor = new Executor();
    const outcome = await executor.run(ctx);
    expect(outcome.status).toBe('handoff');
  });

  it('persists request and decision to confirmations.jsonl', async () => {
    const gateway = new FakeConfirmationGateway(() => ({
      confirmation_id: '',
      decision: 'granted',
      decided_at: '2026-07-01T00:00:01.000Z',
      decided_by: 'user_interactive',
    }));
    const store = createConfirmationStore(tmpDir);
    const plan = makePlan([makeClickStep('s1', true)]);
    const ctx = makeContext(plan, tmpDir, gateway, store);
    const executor = new Executor();
    await executor.run(ctx);
    const entries = await store.readAll();
    expect(entries.length).toBeGreaterThanOrEqual(2);
    const requests = entries.filter((e) => e.kind === 'request');
    const decisions = entries.filter((e) => e.kind === 'decision');
    expect(requests).toHaveLength(1);
    expect(decisions).toHaveLength(1);
  });
});
