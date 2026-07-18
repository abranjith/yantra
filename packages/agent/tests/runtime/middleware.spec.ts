import { DefaultSanitizer } from '@yantra/core';
import type { ConfirmationGateway, ConfirmationOutcome, ConfirmationRequest } from '@yantra/core';
import { Type } from 'typebox';
import { describe, expect, it, vi } from 'vitest';

import {
  BudgetTracker,
  DEFAULT_BUDGET_LIMITS,
  type BudgetLimits,
} from '../../src/runtime/budget.js';
import { wrapTool, type DomainResult, type ToolWrapperSpec } from '../../src/runtime/middleware.js';
import { ActionPhase, type RunServices } from '../../src/runtime/run-services.js';
import { UrlPolicy } from '../../src/runtime/url-policy.js';

const CANARY = 'sk-CANARYtokenABCDEFGHIJKLMNOP';

interface ServicesOverrides {
  readonly limits?: Partial<BudgetLimits>;
  readonly abortSignal?: AbortSignal;
  readonly gateway?: ConfirmationGateway;
  readonly actionPhase?: ActionPhase;
}

function makeServices(overrides: ServicesOverrides = {}): RunServices {
  const budgets = new BudgetTracker({ ...DEFAULT_BUDGET_LIMITS, ...overrides.limits });
  const sanitizer = new DefaultSanitizer();
  return {
    runId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    runDir: '/tmp/run',
    budgets,
    sanitizer,
    urlPolicy: new UrlPolicy(budgets),
    confirmation: overrides.gateway ? { gateway: overrides.gateway, store: null } : null,
    actionPhase: overrides.actionPhase ?? new ActionPhase(),
    trace: null,
    abortSignal: overrides.abortSignal ?? new AbortController().signal,
    now: () => Date.now(),
    nowIso: () => new Date().toISOString(),
    // Domain deps are unused by these synthetic-spec tests.
    domain: undefined as unknown as RunServices['domain'],
  };
}

const OK: DomainResult = { ok: true, model: { answer: 42 } };

/** A minimal spec with a stubbable domain op. */
function spec(
  run: ToolWrapperSpec['run'],
  extra: Partial<ToolWrapperSpec> = {},
): ToolWrapperSpec<ReturnType<typeof paramsSchema>> {
  return {
    name: 'demo_tool',
    label: 'Demo',
    description: 'A demo tool. Use it in tests only; do not use it in production.',
    parameters: paramsSchema(),
    sanitizationProfile: 'public',
    run,
    ...extra,
  };
}

function paramsSchema() {
  return Type.Object({ q: Type.String() }, { additionalProperties: false });
}

describe('@no-llm middleware stage short-circuiting', () => {
  it('rejects invalid input before reserving budget or reaching the domain op', async () => {
    const run = vi.fn(async () => OK);
    const services = makeServices();
    const tool = wrapTool(spec(run), services);

    const result = await tool.execute({ q: 123, extra: 'nope' }, undefined);

    expect(result.status).toBe('error');
    expect(result.error_code).toBe('INVALID_INPUT');
    expect(result.retryable).toBe(true);
    expect(run).not.toHaveBeenCalled();
    expect(services.budgets.snapshot().totalCalls).toBe(0);
  });

  it('names the failing field path in the INVALID_INPUT message', async () => {
    // Regression: the middleware read `path` from TypeBox errors, but the
    // pinned TypeBox reports `instancePath` — so no tool ever told the model
    // WHICH field was invalid, breaking the structured retry loop for models
    // that depend on it (run 20260717T223950Z-research-03a436fd).
    const services = makeServices();
    const tool = wrapTool(
      spec(async () => OK),
      services,
    );

    const result = await tool.execute({ q: 123 }, undefined);

    expect(result.error_code).toBe('INVALID_INPUT');
    expect(result.modelText).toContain('/q');
  });

  it('rejects unknown extra keys (closed schema)', async () => {
    const services = makeServices();
    const tool = wrapTool(
      spec(async () => OK),
      services,
    );
    const result = await tool.execute({ q: 'hi', sneaky: true }, undefined);
    expect(result.error_code).toBe('INVALID_INPUT');
  });

  it('returns BUDGET_EXHAUSTED without invoking policy or the domain op', async () => {
    const run = vi.fn(async () => OK);
    const policy = vi.fn(() => null);
    const services = makeServices({ limits: { perToolCalls: 1 } });
    const tool = wrapTool(spec(run, { policy }), services);

    expect((await tool.execute({ q: 'a' }, undefined)).status).toBe('ok');
    const denied = await tool.execute({ q: 'b' }, undefined);

    expect(denied.status).toBe('error');
    expect(denied.error_code).toBe('BUDGET_EXHAUSTED');
    expect(run).toHaveBeenCalledTimes(1);
    expect(policy).toHaveBeenCalledTimes(1);
  });

  it('short-circuits on a policy refusal before the domain op', async () => {
    const run = vi.fn(async () => OK);
    const services = makeServices();
    const tool = wrapTool(
      spec(run, {
        policy: () => ({
          ok: false,
          errorCode: 'HOST_BLOCKED',
          message: 'blocked',
          retryable: false,
        }),
      }),
      services,
    );
    const result = await tool.execute({ q: 'a' }, undefined);
    expect(result.error_code).toBe('HOST_BLOCKED');
    expect(run).not.toHaveBeenCalled();
  });
});

describe('@no-llm middleware confirmation gateway', () => {
  const grant = (): ConfirmationGateway => ({
    request: (req: ConfirmationRequest): Promise<ConfirmationOutcome> =>
      Promise.resolve({
        confirmation_id: req.confirmation_id,
        decision: 'granted',
        decided_at: new Date().toISOString(),
        decided_by: 'user_interactive',
      }),
  });
  const deny = (): ConfirmationGateway => ({
    request: (req: ConfirmationRequest): Promise<ConfirmationOutcome> =>
      Promise.resolve({
        confirmation_id: req.confirmation_id,
        decision: 'denied',
        decided_at: new Date().toISOString(),
        decided_by: 'user_interactive',
      }),
  });

  const confirmedSpec = (
    run: ToolWrapperSpec['run'],
  ): ToolWrapperSpec<ReturnType<typeof paramsSchema>> =>
    spec(run, {
      mutating: true,
      requiresConfirmation: () => true,
      buildConfirmation: () => ({
        action_kind: 'navigate',
        host: 'example.com',
        description: 'Do the risky thing',
      }),
    });

  it('runs the domain op and threads confirmation_id when granted', async () => {
    const run = vi.fn(async () => OK);
    const services = makeServices({ gateway: grant() });
    const tool = wrapTool(confirmedSpec(run), services);
    const result = await tool.execute({ q: 'a' }, undefined);
    expect(result.status).toBe('ok');
    expect(result.confirmation_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('returns denied and never runs the side effect when denied', async () => {
    const run = vi.fn(async () => OK);
    const services = makeServices({ gateway: deny() });
    const tool = wrapTool(confirmedSpec(run), services);
    const result = await tool.execute({ q: 'a' }, undefined);
    expect(result.status).toBe('denied');
    expect(result.error_code).toBe('CONFIRMATION_DENIED');
    expect(run).not.toHaveBeenCalled();
  });

  it('fails closed when confirmation is required but no gateway is wired', async () => {
    const run = vi.fn(async () => OK);
    const services = makeServices(); // no gateway
    const tool = wrapTool(confirmedSpec(run), services);
    const result = await tool.execute({ q: 'a' }, undefined);
    expect(result.status).toBe('denied');
    expect(result.error_code).toBe('CONFIRMATION_UNAVAILABLE');
    expect(run).not.toHaveBeenCalled();
  });
});

describe('@no-llm middleware abort and timeout', () => {
  it('cancels a running domain op and reports aborted', async () => {
    const controller = new AbortController();
    const services = makeServices({ abortSignal: controller.signal });
    const run = (_params: unknown, ctx: { signal: AbortSignal }): Promise<DomainResult> =>
      new Promise((resolve) => {
        // Never resolves on its own; the merged signal aborts it.
        ctx.signal.addEventListener('abort', () => resolve({ ok: true, model: 'late' }), {
          once: true,
        });
      });
    const tool = wrapTool(spec(run), services);

    const pending = tool.execute({ q: 'a' }, undefined);
    controller.abort();
    const result = await pending;

    expect(result.status).toBe('aborted');
    expect(result.error_code).toBe('AGENT_ABORTED');
  });

  it('times out a slow domain op with a stable code', async () => {
    const services = makeServices({ limits: { perToolTimeoutMs: 10 } });
    const run = (): Promise<DomainResult> => new Promise<DomainResult>(() => undefined); // never resolves
    const tool = wrapTool(spec(run), services);
    const result = await tool.execute({ q: 'a' }, undefined);
    expect(result.status).toBe('error');
    expect(result.error_code).toBe('TOOL_TIMEOUT');
    expect(result.retryable).toBe(true);
  });

  it('returns aborted immediately when the run is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const run = vi.fn(async () => OK);
    const services = makeServices({ abortSignal: controller.signal });
    const tool = wrapTool(spec(run), services);
    const result = await tool.execute({ q: 'a' }, undefined);
    expect(result.status).toBe('aborted');
    expect(run).not.toHaveBeenCalled();
  });
});

describe('@no-llm middleware error genericization and sanitization', () => {
  it('maps an unexpected throw to a generic error with no secret leak', async () => {
    const services = makeServices();
    const run = (): Promise<DomainResult> => {
      throw new Error(`boom ${CANARY}`);
    };
    const tool = wrapTool(spec(run), services);
    const result = await tool.execute({ q: 'a' }, undefined);
    expect(result.status).toBe('error');
    expect(result.error_code).toBe('TOOL_EXECUTION_FAILED');
    expect(JSON.stringify(result)).not.toContain(CANARY);
  });

  it('sanitizes credential shapes out of a successful model payload', async () => {
    const services = makeServices();
    const run = async (): Promise<DomainResult> => ({
      ok: true,
      model: { note: `token is ${CANARY}` },
    });
    const tool = wrapTool(spec(run), services);
    const result = await tool.execute({ q: 'a' }, undefined);
    expect(result.status).toBe('ok');
    expect(result.modelText).not.toContain(CANARY);
    expect(result.modelText).toContain('[redacted-api-key]');
  });

  it('bounds the model-visible result to the per-result byte budget', async () => {
    const services = makeServices({ limits: { maxBytesPerResult: 64 } });
    const run = async (): Promise<DomainResult> => ({ ok: true, model: 'x'.repeat(5000) });
    const tool = wrapTool(spec(run), services);
    const result = await tool.execute({ q: 'a' }, undefined);
    expect(Buffer.byteLength(result.modelText, 'utf8')).toBeLessThanOrEqual(64);
  });

  it('always returns exactly one terminal status (one end per call)', async () => {
    const services = makeServices();
    const tool = wrapTool(
      spec(async () => OK),
      services,
    );
    const result = await tool.execute({ q: 'a' }, undefined);
    expect(['ok', 'error', 'denied', 'aborted']).toContain(result.status);
  });
});
