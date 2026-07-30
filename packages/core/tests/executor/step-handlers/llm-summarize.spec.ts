// @no-llm
/**
 * `llm_summarize` without a model (FEAT-FP-001, TASK-007).
 *
 * This step used to fail hard when no model was wired, which made any workflow
 * containing it unschedulable — scheduled fires are hard zero-LLM by policy. It
 * now passes its input through so the run still completes with a value bound to
 * `output_as`.
 */

import type { LLMSummarizeStep, TaskEvent } from '@yantra/protocol';
import { TaskEvent as TaskEventSchema } from '@yantra/protocol';
import { describe, expect, it, vi } from 'vitest';

import { InMemoryCaptureStore } from '../../../src/executor/capture-store.js';
import { handleLlmSummarize } from '../../../src/executor/step-handlers/llm_summarize.js';
import type { ExecutionContext } from '../../../src/executor/types.js';

const FIXED_CLOCK_MS = Date.parse('2026-07-28T12:34:56.000Z');

const step: LLMSummarizeStep = {
  type: 'llm_summarize',
  id: 's4',
  scope: 'public',
  input: { step_id: 'extracted' },
  prompt: 'Summarize the transactions.',
  output_as: 'summary',
} as unknown as LLMSummarizeStep;

function makeCtx(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  const published: TaskEvent[] = [];
  const ctx = {
    runId: 'run-1',
    taskId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    plan: {
      schema_version: '0.1',
      plan_id: 'p1',
      task_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
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
    page: null,
    locatorHost: null,
    settler: null,
    events: {
      publish: (event: TaskEvent) => published.push(event),
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
    evidence: null,
    ...overrides,
  } as unknown as ExecutionContext;

  return Object.assign(ctx, { __published: published }) as ExecutionContext;
}

function publishedEvents(ctx: ExecutionContext): TaskEvent[] {
  return (ctx as unknown as { __published: TaskEvent[] }).__published;
}

const envelope = {
  rows: [{ amount: 12 }, { amount: 34 }],
  metadata: { total_rows: 2, valid_rows: 2, error_count: 0 },
};

describe('@no-llm handleLlmSummarize pass-through', () => {
  it('completes and binds the raw envelope to output_as when no client is wired', async () => {
    const ctx = makeCtx();
    ctx.captures.set('extracted', envelope);

    const result = await handleLlmSummarize(step, ctx);

    expect(result).toEqual({ kind: 'completed', captureKeys: ['summary'] });
    expect(ctx.captures.get('summary')).toEqual(envelope);
  });

  it('passes through when the sanitizer is missing but a client exists', async () => {
    const ctx = makeCtx({
      sanitizer: null,
      llmClient: { summarize: vi.fn() } as unknown as ExecutionContext['llmClient'],
    });
    ctx.captures.set('extracted', envelope);

    const result = await handleLlmSummarize(step, ctx);

    expect(result.kind).toBe('completed');
    expect(ctx.captures.get('summary')).toEqual(envelope);
  });

  it('passes through a plain string capture unchanged', async () => {
    const ctx = makeCtx();
    ctx.captures.set('extracted', 'Revenue rose 12%.');

    await handleLlmSummarize(step, ctx);

    expect(ctx.captures.get('summary')).toBe('Revenue rose 12%.');
  });

  it('publishes exactly one schema-valid llm_step_skipped event', async () => {
    const ctx = makeCtx();
    ctx.captures.set('extracted', envelope);

    await handleLlmSummarize(step, ctx);

    const skips = publishedEvents(ctx).filter((event) => event.kind === 'llm_step_skipped');
    expect(skips).toHaveLength(1);
    expect(TaskEventSchema.safeParse(skips[0]).success).toBe(true);
    expect(skips[0]).toMatchObject({ step_id: 's4', output_as: 'summary' });
  });

  it('timestamps the skip event from the injected clock', async () => {
    const ctx = makeCtx();
    ctx.captures.set('extracted', envelope);

    await handleLlmSummarize(step, ctx);

    expect(publishedEvents(ctx)[0]?.at).toBe('2026-07-28T12:34:56.000Z');
  });

  it('names the missing dependency in the skip reason', async () => {
    const noClient = makeCtx();
    noClient.captures.set('extracted', envelope);
    await handleLlmSummarize(step, noClient);

    const noSanitizer = makeCtx({
      llmClient: { summarize: vi.fn() } as unknown as ExecutionContext['llmClient'],
    });
    noSanitizer.captures.set('extracted', envelope);
    await handleLlmSummarize(step, noSanitizer);

    const reasonOf = (ctx: ExecutionContext): string =>
      (publishedEvents(ctx)[0] as unknown as { reason: string }).reason;
    expect(reasonOf(noClient)).toContain('model client');
    expect(reasonOf(noSanitizer)).toContain('sanitizer');
  });

  it('still fails when the input capture is missing', async () => {
    // An authoring bug, not a mode difference: binding undefined would hide it.
    const ctx = makeCtx();

    const result = await handleLlmSummarize(step, ctx);

    expect(result.kind).toBe('failed');
    expect(ctx.captures.has('summary')).toBe(false);
    expect(publishedEvents(ctx)).toHaveLength(0);
  });

  it('fails on a missing input capture even when a model is fully wired', async () => {
    const ctx = makeCtx({
      sanitizer: {
        sanitize: () => ({ text: 'x' }),
      } as unknown as ExecutionContext['sanitizer'],
      llmClient: { summarize: vi.fn() } as unknown as ExecutionContext['llmClient'],
    });

    const result = await handleLlmSummarize(step, ctx);

    expect(result.kind).toBe('failed');
  });
});

describe('@no-llm handleLlmSummarize model path', () => {
  function wiredCtx(summarize: ReturnType<typeof vi.fn>): ExecutionContext {
    return makeCtx({
      sanitizer: {
        sanitize: (payload: unknown) => ({ text: JSON.stringify(payload) }),
      } as unknown as ExecutionContext['sanitizer'],
      llmClient: { summarize } as unknown as ExecutionContext['llmClient'],
    });
  }

  it('sanitizes, sends, and binds the summary when both are wired', async () => {
    const summarize = vi.fn().mockResolvedValue({ text: 'Two transactions.', usage: {} });
    const ctx = wiredCtx(summarize);
    ctx.captures.set('extracted', envelope);

    const result = await handleLlmSummarize(step, ctx);

    expect(result).toEqual({ kind: 'completed', captureKeys: ['summary'] });
    expect(ctx.captures.get('summary')).toBe('Two transactions.');
    expect(summarize).toHaveBeenCalledWith(
      JSON.stringify({ rows: envelope.rows }),
      'Summarize the transactions.',
    );
  });

  it('publishes no skip event on the model path', async () => {
    const ctx = wiredCtx(vi.fn().mockResolvedValue({ text: 'ok', usage: {} }));
    ctx.captures.set('extracted', envelope);

    await handleLlmSummarize(step, ctx);

    expect(publishedEvents(ctx).filter((e) => e.kind === 'llm_step_skipped')).toHaveLength(0);
  });

  it('fails when the model call throws', async () => {
    const ctx = wiredCtx(vi.fn().mockRejectedValue(new Error('provider 503')));
    ctx.captures.set('extracted', envelope);

    const result = await handleLlmSummarize(step, ctx);

    expect(result.kind).toBe('failed');
  });

  it('drops extraction error rows before sending', async () => {
    const summarize = vi.fn().mockResolvedValue({ text: 'ok', usage: {} });
    const ctx = wiredCtx(summarize);
    ctx.captures.set('extracted', {
      rows: [{ amount: 12 }, { __error: 'bad row', __raw: null }],
      metadata: { total_rows: 2, valid_rows: 1, error_count: 1 },
    });

    await handleLlmSummarize(step, ctx);

    expect(summarize.mock.calls[0]?.[0]).toBe(JSON.stringify({ rows: [{ amount: 12 }] }));
  });
});
