// @no-llm
import type { ExtractStep } from '@yantra/protocol';
import { describe, expect, it, vi } from 'vitest';

// Mock locator-helpers so the handler runs without a browser/injected host.
vi.mock('../../../src/executor/step-handlers/locator-helpers.js', () => ({
  resolveLocatorChain: vi.fn(),
}));

import { InMemoryCaptureStore } from '../../../src/executor/capture-store.js';
import { ReplayEvidenceLedger } from '../../../src/executor/evidence-ledger.js';
import { handleExtract } from '../../../src/executor/step-handlers/extract.js';
import { resolveLocatorChain } from '../../../src/executor/step-handlers/locator-helpers.js';
import type { ExecutionContext } from '../../../src/executor/types.js';

const FIXED_CLOCK_MS = Date.parse('2026-07-28T12:34:56.000Z');

const makeCtx = (overrides: Partial<ExecutionContext> = {}): ExecutionContext =>
  ({
    runId: 'run-1',
    taskId: 'task-1',
    plan: {
      schema_version: '0.1',
      plan_id: 'p1',
      task_id: 'task-1',
      default_scope: 'public',
      steps: [],
    },
    currentStepIdx: 0,
    captures: new InMemoryCaptureStore(),
    secrets: null,
    sanitizer: null,
    llmClient: null,
    workflowLocators: null,
    browser: null,
    page: {
      url: () => 'https://example.com/report?q=1',
      evaluate: vi.fn().mockResolvedValue('Quarterly report'),
    },
    locatorHost: {},
    settler: null,
    events: {
      publish: vi.fn(),
      flush: vi.fn().mockResolvedValue(undefined),
      persistedAt: vi.fn().mockReturnValue(null),
      close: vi.fn().mockResolvedValue(undefined),
    },
    budgets: { canRetry: vi.fn().mockReturnValue(false), consume: vi.fn() },
    ethics: { check: vi.fn().mockResolvedValue(undefined) },
    checkpoints: { save: vi.fn(), load: vi.fn(), list: vi.fn(), loadLast: vi.fn() },
    scopeChain: ['public'],
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    clock: { now: () => FIXED_CLOCK_MS, setTimeout: vi.fn(), clearTimeout: vi.fn() },
    runDir: '/tmp/run-1',
    confirmationGateway: null,
    confirmationStore: null,
    evidence: new ReplayEvidenceLedger(),
    ...overrides,
  }) as unknown as ExecutionContext;

const readableStep: ExtractStep = {
  type: 'extract',
  id: 's3',
  scope: 'public',
  locator: { kind: 'recorded', step_index: 0 },
  extraction_schema: { type: 'primitive', kind: 'readable' },
  capture_as: 'body',
} as unknown as ExtractStep;

const tableStep: ExtractStep = {
  type: 'extract',
  id: 's4',
  scope: 'public',
  locator: { kind: 'recorded', step_index: 0 },
  extraction_schema: {
    type: 'array',
    items: { type: 'object', fields: { name: { type: 'primitive', kind: 'string' } } },
  },
  capture_as: 'rows',
} as unknown as ExtractStep;

const mockResolve = vi.mocked(resolveLocatorChain);

/** Resolves to an element handle whose `evaluate` returns `value`. */
function resolvesTo(value: unknown): void {
  mockResolve.mockResolvedValue({
    kind: 'found',
    elementHandle: { evaluate: vi.fn().mockResolvedValue(value) },
  } as never);
}

describe('@no-llm handleExtract evidence recording', () => {
  it('appends an evidence entry on a successful readable extract', async () => {
    resolvesTo({ html: '<p>Revenue rose 4%.</p>', text: 'Revenue rose 4%.' });
    const ctx = makeCtx();

    const result = await handleExtract(readableStep, ctx);

    expect(result.kind).toBe('completed');
    const entries = ctx.evidence?.entries() ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0]?.url).toBe('https://example.com/report?q=1');
    expect(entries[0]?.host).toBe('example.com');
    expect(entries[0]?.title).toBe('Quarterly report');
    expect(entries[0]?.stepId).toBe('s3');
    expect(entries[0]?.finalUrl).toBeNull();
    expect(entries[0]?.text).toContain('Revenue rose 4%');
  });

  it('serializes table rows into the evidence text', async () => {
    resolvesTo([{ name: 'Alpha' }, { name: 'Beta' }]);
    const ctx = makeCtx();

    const result = await handleExtract(tableStep, ctx);

    expect(result.kind).toBe('completed');
    const entry = ctx.evidence?.entries()[0];
    expect(entry?.text).toBe('{"name":"Alpha"}\n{"name":"Beta"}');
    expect(entry?.stepId).toBe('s4');
  });

  it('takes fetchedAt from the injected clock, not wall time', async () => {
    resolvesTo({ html: '<p>x</p>', text: 'x' });
    const ctx = makeCtx();

    await handleExtract(readableStep, ctx);

    expect(ctx.evidence?.entries()[0]?.fetchedAt).toBe('2026-07-28T12:34:56.000Z');
  });

  it('records a null title when the page cannot report one', async () => {
    resolvesTo({ html: '<p>x</p>', text: 'x' });
    const ctx = makeCtx({
      page: {
        url: () => 'https://example.com/',
        evaluate: vi.fn().mockRejectedValue(new Error('detached')),
      } as unknown as ExecutionContext['page'],
    });

    const result = await handleExtract(readableStep, ctx);

    expect(result.kind).toBe('completed');
    expect(ctx.evidence?.entries()[0]?.title).toBeNull();
  });

  it('leaves the extract completed when the ledger throws', async () => {
    resolvesTo({ html: '<p>x</p>', text: 'x' });
    const throwingLedger = {
      append: () => {
        throw new Error('ledger exploded');
      },
      entries: () => [],
      overflowCount: () => 0,
    };
    const ctx = makeCtx({
      evidence: throwingLedger as unknown as ExecutionContext['evidence'],
    });

    const result = await handleExtract(readableStep, ctx);

    expect(result.kind).toBe('completed');
    expect(ctx.captures.get('body')).toBeDefined();
    expect(ctx.logger.debug).toHaveBeenCalled();
  });

  it('is a no-op when no ledger is wired', async () => {
    resolvesTo({ html: '<p>x</p>', text: 'x' });
    const ctx = makeCtx({ evidence: null });

    const result = await handleExtract(readableStep, ctx);

    expect(result.kind).toBe('completed');
    expect(ctx.captures.get('body')).toBeDefined();
  });

  it('still stores the capture when the page url is unavailable at record time', async () => {
    resolvesTo([{ name: 'Alpha' }]);
    const ctx = makeCtx({
      page: {
        url: () => {
          throw new Error('no page');
        },
        evaluate: vi.fn().mockResolvedValue(null),
      } as unknown as ExecutionContext['page'],
    });

    const result = await handleExtract(tableStep, ctx);

    expect(result.kind).toBe('completed');
    expect(ctx.captures.get('rows')).toBeDefined();
    expect(ctx.evidence?.entries()).toHaveLength(0);
  });
});
