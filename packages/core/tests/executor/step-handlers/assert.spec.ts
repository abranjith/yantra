import { describe, expect, it, vi } from 'vitest';

// Mock locator-helpers to avoid needing a real browser/injected script host
vi.mock('../../../src/executor/step-handlers/locator-helpers.js', () => ({
  resolveLocatorChain: vi.fn(),
}));

import { handleAssert } from '../../../src/executor/step-handlers/assert.js';
import { resolveLocatorChain } from '../../../src/executor/step-handlers/locator-helpers.js';
import { InMemoryCaptureStore } from '../../../src/executor/capture-store.js';
import type { ExecutionContext } from '../../../src/executor/types.js';

const makeCtx = (overrides: Partial<ExecutionContext> = {}): ExecutionContext => ({
  runId: 'run-1',
  taskId: 'task-1',
  plan: { schema_version: '0.1', plan_id: 'p1', task_id: 'task-1', default_scope: 'public', steps: [] },
  currentStepIdx: 0,
  captures: new InMemoryCaptureStore(),
  secrets: null,
  sanitizer: null,
  llmClient: null,
  workflowLocators: null,
  browser: null,
  page: {} as never,
  locatorHost: {} as never, // provided so assert doesn't short-circuit
  events: { publish: vi.fn(), flush: vi.fn().mockResolvedValue(undefined), persistedAt: vi.fn().mockReturnValue(null), close: vi.fn().mockResolvedValue(undefined) },
  budgets: { canRetry: vi.fn(), consume: vi.fn(), initial: vi.fn(), remaining: vi.fn(), snapshot: vi.fn(), clone: vi.fn() },
  ethics: { check: vi.fn().mockResolvedValue(undefined) },
  checkpoints: { save: vi.fn(), load: vi.fn(), list: vi.fn(), loadLast: vi.fn() },
  scopeChain: ['public'],
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
  clock: { now: () => 0, setTimeout: vi.fn(), clearTimeout: vi.fn() },
  runDir: '/tmp/run-1',
  ...overrides,
});

const baseAssert = {
  type: 'assert' as const,
  id: 's1',
  scope: 'public' as const,
  locator: { kind: 'recorded' as const, step_index: 0 },
};

const mockResolve = vi.mocked(resolveLocatorChain);

describe('@no-llm handleAssert', () => {
  it('returns failed when no browser session (locatorHost=null)', async () => {
    const result = await handleAssert(
      { ...baseAssert, condition: { kind: 'visible' as const } },
      makeCtx({ locatorHost: null, page: null }),
    );
    expect(result.kind).toBe('failed');
  });

  describe('visible condition', () => {
    it('returns completed when element is found', async () => {
      mockResolve.mockResolvedValue({ kind: 'found', elementHandle: {} as never, chainName: 'c' });
      const result = await handleAssert({ ...baseAssert, condition: { kind: 'visible' } }, makeCtx());
      expect(result.kind).toBe('completed');
    });

    it('returns failed when element is not found', async () => {
      mockResolve.mockResolvedValue({ kind: 'not_found', chainName: 'c', candidatesCount: 0 });
      const result = await handleAssert({ ...baseAssert, condition: { kind: 'visible' } }, makeCtx());
      expect(result.kind).toBe('failed');
    });

    it('returns failed on resolution error', async () => {
      mockResolve.mockResolvedValue({ kind: 'error', error: new Error('browser crash') });
      const result = await handleAssert({ ...baseAssert, condition: { kind: 'visible' } }, makeCtx());
      expect(result.kind).toBe('failed');
    });
  });

  describe('hidden condition', () => {
    it('returns completed when element is not found', async () => {
      mockResolve.mockResolvedValue({ kind: 'not_found', chainName: 'c', candidatesCount: 0 });
      const result = await handleAssert({ ...baseAssert, condition: { kind: 'hidden' } }, makeCtx());
      expect(result.kind).toBe('completed');
    });

    it('returns failed when element is visible', async () => {
      mockResolve.mockResolvedValue({ kind: 'found', elementHandle: {} as never, chainName: 'c' });
      const result = await handleAssert({ ...baseAssert, condition: { kind: 'hidden' } }, makeCtx());
      expect(result.kind).toBe('failed');
    });
  });

  describe('text_matches condition', () => {
    it('returns completed when text matches pattern', async () => {
      const el = { evaluate: vi.fn().mockResolvedValue('Hello World') };
      mockResolve.mockResolvedValue({ kind: 'found', elementHandle: el as never, chainName: 'c' });
      const result = await handleAssert(
        { ...baseAssert, condition: { kind: 'text_matches', pattern: 'hello', flags: 'i' } },
        makeCtx(),
      );
      expect(result.kind).toBe('completed');
    });

    it('returns failed when text does not match', async () => {
      const el = { evaluate: vi.fn().mockResolvedValue('Hello World') };
      mockResolve.mockResolvedValue({ kind: 'found', elementHandle: el as never, chainName: 'c' });
      const result = await handleAssert(
        { ...baseAssert, condition: { kind: 'text_matches', pattern: 'ZZZ', flags: '' } },
        makeCtx(),
      );
      expect(result.kind).toBe('failed');
    });
  });

  describe('count_equals condition', () => {
    it('returns completed when count matches (1 found)', async () => {
      mockResolve.mockResolvedValue({ kind: 'found', elementHandle: {} as never, chainName: 'c' });
      const result = await handleAssert(
        { ...baseAssert, condition: { kind: 'count_equals', count: 1 } },
        makeCtx(),
      );
      expect(result.kind).toBe('completed');
    });

    it('returns completed when count=0 and element not found', async () => {
      mockResolve.mockResolvedValue({ kind: 'not_found', chainName: 'c', candidatesCount: 0 });
      const result = await handleAssert(
        { ...baseAssert, condition: { kind: 'count_equals', count: 0 } },
        makeCtx(),
      );
      expect(result.kind).toBe('completed');
    });

    it('returns failed when count does not match', async () => {
      mockResolve.mockResolvedValue({ kind: 'not_found', chainName: 'c', candidatesCount: 0 });
      const result = await handleAssert(
        { ...baseAssert, condition: { kind: 'count_equals', count: 5 } },
        makeCtx(),
      );
      expect(result.kind).toBe('failed');
    });
  });
});
