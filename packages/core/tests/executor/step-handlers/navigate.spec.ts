import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { handleNavigate } from '../../../src/executor/step-handlers/navigate.js';
import { EthicsRefusedError } from '../../../src/executor/errors.js';
import type { ExecutionContext } from '../../../src/executor/types.js';
import { InMemoryCaptureStore } from '../../../src/executor/capture-store.js';

const makeStep = (url = 'https://example.com') => ({
  type: 'navigate' as const,
  id: 's1',
  url: { kind: 'literal' as const, value: url },
  scope: 'public' as const,
});

const makeCaptures = () => new InMemoryCaptureStore();

const makeCtx = (overrides: Partial<ExecutionContext> = {}): ExecutionContext => ({
  runId: 'run-1',
  taskId: 'task-1',
  plan: {
    schema_version: '0.1',
    plan_id: 'plan-1',
    task_id: 'task-1',
    default_scope: 'public',
    steps: [makeStep()],
  },
  currentStepIdx: 0,
  captures: makeCaptures(),
  secrets: null,
  sanitizer: null,
  llmClient: null,
  workflowLocators: null,
  browser: null,
  page: null,
  locatorHost: null,
  events: { publish: vi.fn(), flush: vi.fn().mockResolvedValue(undefined), persistedAt: vi.fn().mockReturnValue(null), close: vi.fn().mockResolvedValue(undefined) },
  budgets: { canRetry: vi.fn().mockReturnValue(true), consume: vi.fn(), initial: vi.fn().mockReturnValue(3), remaining: vi.fn().mockReturnValue(3), snapshot: vi.fn().mockReturnValue({}), clone: vi.fn() },
  ethics: {
    check: vi.fn().mockResolvedValue(undefined),
  },
  checkpoints: { save: vi.fn(), load: vi.fn(), list: vi.fn(), loadLast: vi.fn() },
  scopeChain: ['public'],
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
  clock: { now: () => 0, setTimeout: vi.fn(), clearTimeout: vi.fn() },
  runDir: '/tmp/run-1',
  ...overrides,
});

describe('@no-llm handleNavigate', () => {
  it('calls ethics.check before any page interaction', async () => {
    const ctx = makeCtx();
    // No page attached — if ethics.check is called first, it passes,
    // then we'll get a "no active page" failure — not an error thrown from ethics.
    const result = await handleNavigate(makeStep(), ctx);

    expect(ctx.ethics.check).toHaveBeenCalledOnce();
    expect(ctx.ethics.check).toHaveBeenCalledWith(
      'https://example.com',
      'navigate',
      { taskId: 'task-1', runId: 'run-1', stepId: 's1' },
    );
  });

  it('returns ethics_refused when EthicsRefusedError is thrown', async () => {
    const ctx = makeCtx();
    vi.mocked(ctx.ethics.check).mockRejectedValue(
      new EthicsRefusedError(
        { host: 'example.com', rule: 'ads', reason: 'blocked', source: 'blocklist' },
        { taskId: 'task-1', runId: 'run-1', stepId: 's1' },
      ),
    );

    const result = await handleNavigate(makeStep(), ctx);
    expect(result.kind).toBe('ethics_refused');
    if (result.kind === 'ethics_refused') {
      expect(result.host).toBe('example.com');
      expect(result.rule).toBe('ads');
    }
  });

  it('returns failed when no page is available after ethics passes', async () => {
    const ctx = makeCtx({ page: null });
    const result = await handleNavigate(makeStep(), ctx);
    expect(result.kind).toBe('failed');
  });

  it('returns completed on a successful navigation', async () => {
    const mockPage = {
      goto: vi.fn().mockResolvedValue({ status: () => 200 }),
    };
    const ctx = makeCtx({ page: mockPage as never });
    const result = await handleNavigate(makeStep(), ctx);
    expect(result.kind).toBe('completed');
  });

  it('returns retried on HTTP 429 with Retry-After header', async () => {
    const mockPage = {
      goto: vi.fn().mockResolvedValue({
        status: () => 429,
        headers: () => ({ 'retry-after': '5' }),
      }),
    };
    const ctx = makeCtx({ page: mockPage as never });
    const result = await handleNavigate(makeStep(), ctx);
    expect(result.kind).toBe('retried');
  });

  it('returns failed on HTTP 429 without Retry-After header', async () => {
    const mockPage = {
      goto: vi.fn().mockResolvedValue({
        status: () => 429,
        headers: () => ({}),
      }),
    };
    const ctx = makeCtx({ page: mockPage as never });
    const result = await handleNavigate(makeStep(), ctx);
    expect(result.kind).toBe('failed');
  });

  it('returns failed on HTTP 403 response', async () => {
    const mockPage = {
      goto: vi.fn().mockResolvedValue({
        status: () => 403,
        headers: () => ({}),
      }),
    };
    const ctx = makeCtx({ page: mockPage as never });
    const result = await handleNavigate(makeStep(), ctx);
    expect(result.kind).toBe('failed');
  });

  it('returns failed on navigation timeout', async () => {
    const mockPage = {
      goto: vi.fn().mockRejectedValue(new Error('Navigation timeout exceeded')),
    };
    const ctx = makeCtx({ page: mockPage as never });
    const result = await handleNavigate(makeStep(), ctx);
    expect(result.kind).toBe('failed');
  });
});
