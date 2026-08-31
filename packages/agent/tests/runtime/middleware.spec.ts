import { DefaultSanitizer, ModelSuppliedValues, UserInputVault } from '@yantra/core';
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
import { UrlProvenance } from '../../src/runtime/url-provenance.js';

const CANARY = 'sk-CANARYtokenABCDEFGHIJKLMNOP';

interface ServicesOverrides {
  readonly limits?: Partial<BudgetLimits>;
  readonly abortSignal?: AbortSignal;
  readonly gateway?: ConfirmationGateway;
  readonly actionPhase?: ActionPhase;
  readonly userInput?: UserInputVault;
  readonly modelValues?: ModelSuppliedValues;
}

function makeServices(overrides: ServicesOverrides = {}): RunServices {
  const budgets = new BudgetTracker({ ...DEFAULT_BUDGET_LIMITS, ...overrides.limits });
  const sanitizer = new DefaultSanitizer();
  return {
    runId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    runDir: '/tmp/run',
    budgets,
    sanitizer,
    ...(overrides.userInput ? { userInput: overrides.userInput } : {}),
    ...(overrides.modelValues ? { modelValues: overrides.modelValues } : {}),
    urlPolicy: new UrlPolicy(budgets),
    urlProvenance: new UrlProvenance(),
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
    const services = makeServices({ limits: { maxBytesPerRun: 1 } });
    const tool = wrapTool(spec(run, { policy }), services);

    services.budgets.accountResultBytes(2);
    const denied = await tool.execute({ q: 'a' }, undefined);

    expect(denied.status).toBe('error');
    expect(denied.error_code).toBe('BUDGET_EXHAUSTED');
    expect(run).not.toHaveBeenCalled();
    expect(policy).not.toHaveBeenCalled();
  });

  it('reports which budget limit tripped so the orchestrator can classify it', async () => {
    const services = makeServices({ limits: { maxBytesPerRun: 1 } });
    const tool = wrapTool(
      spec(async () => OK),
      services,
    );

    services.budgets.accountResultBytes(2);
    const denied = await tool.execute({ q: 'b' }, undefined);

    expect(denied.error_code).toBe('BUDGET_EXHAUSTED');
    expect(denied.details).toMatchObject({ budget_limit: 'cumulative-bytes' });
  });

  it('tells a starved non-terminal tool to publish what it already gathered', async () => {
    const services = makeServices({ limits: { maxBytesPerRun: 1 } });
    const tool = wrapTool(
      spec(async () => OK),
      services,
    );

    services.budgets.accountResultBytes(2);
    const denied = await tool.execute({ q: 'b' }, undefined);

    expect(denied.modelText).toContain('Publish your result now');
  });

  it('does not repeat a publish instruction the budget decision already made', async () => {
    // The soft wall-clock refusal's own message ends "Publish now using the
    // evidence already gathered." Appending the caller's near-identical
    // sentence on top of it made the agent read the same instruction twice for
    // every non-terminal tool.
    let now = 0;
    const budgets = new BudgetTracker(
      { ...DEFAULT_BUDGET_LIMITS, wallClockMs: 1_000, softWallClockFraction: 0.5 },
      () => now,
    );
    const services = { ...makeServices(), budgets };
    const tool = wrapTool(
      spec(async () => OK),
      services,
    );

    now = 600;
    const denied = await tool.execute({ q: 'b' }, undefined);

    expect(denied.error_code).toBe('BUDGET_EXHAUSTED');
    expect(denied.details).toMatchObject({ budget_limit: 'wall-clock-soft' });
    expect(denied.modelText).not.toContain('Publish your result now');
    expect((denied.modelText.match(/publish/gi) ?? []).length).toBe(1);
  });

  it('runs a terminal tool after the cumulative byte budget is spent', async () => {
    // Regression: `result_publish` is the only way to complete a run. Charging
    // it against the exploration pool let a fully-researched run be denied its
    // own publication and finalize as budget_exhausted.
    const services = makeServices({ limits: { maxBytesPerRun: 1 } });
    const explore = wrapTool(
      spec(async () => OK),
      services,
    );
    const publishRun = vi.fn(async () => OK);
    const publish = wrapTool(
      spec(publishRun, { name: 'result_publish', terminal: true }),
      services,
    );

    services.budgets.accountResultBytes(2);
    expect((await explore.execute({ q: 'b' }, undefined)).error_code).toBe('BUDGET_EXHAUSTED');
    const published = await publish.execute({ q: 'c' }, undefined);

    expect(published.status).toBe('ok');
    expect(publishRun).toHaveBeenCalledTimes(1);
    expect(published.modelText).not.toContain('Publish your result now');
  });

  it('does not fail a terminal tool whose own result overruns the run byte cap', async () => {
    // The publish has already happened when its bytes are counted; erroring
    // here would strand a written artifact behind an error result.
    const services = makeServices({ limits: { maxBytesPerRun: 1 } });
    const publish = wrapTool(
      spec(async () => OK, { name: 'result_publish', terminal: true }),
      services,
    );

    const published = await publish.execute({ q: 'c' }, undefined);

    expect(published.status).toBe('ok');
    expect(published.error_code).toBeUndefined();
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

describe('@no-llm middleware user-input placeholder boundary', () => {
  const EMAIL = 'john.doe@example.com';

  function vaultWithEmail(): UserInputVault {
    const vault = new UserInputVault();
    // Simulates the prompt builder redacting the goal at run start.
    vault.redact(`sign up with ${EMAIL}`);
    return vault;
  }

  it('resolves placeholders in tool params so the domain op receives the REAL value', async () => {
    // Regression: irreversible '[redacted-email]' markers reached the domain
    // ops, so browser fills typed junk into pages. The vault placeholder must
    // resolve at the execution boundary.
    const received: string[] = [];
    const run = async (params: { q: string }): Promise<DomainResult> => {
      received.push(params.q);
      return OK;
    };
    const services = makeServices({ userInput: vaultWithEmail() });
    const tool = wrapTool(spec(run as ToolWrapperSpec['run']), services);

    const result = await tool.execute({ q: 'register {{user:email:1}} now' }, undefined);

    expect(result.status).toBe('ok');
    expect(received).toEqual([`register ${EMAIL} now`]);
  });

  it('masks the real value back to its placeholder in model-visible output', async () => {
    const run = async (): Promise<DomainResult> => ({
      ok: true,
      model: { confirmation: `We emailed ${EMAIL}` },
    });
    const services = makeServices({ userInput: vaultWithEmail() });
    const tool = wrapTool(spec(run), services);

    const result = await tool.execute({ q: 'a' }, undefined);

    expect(result.modelText).not.toContain(EMAIL);
    expect(result.modelText).toContain('{{user:email:1}}');
  });

  it('masks the real value in structured failure messages and details', async () => {
    const run = async (): Promise<DomainResult> => ({
      ok: false,
      errorCode: 'FIELD_REJECTED',
      message: `The site rejected ${EMAIL}.`,
      retryable: true,
      details: { rejected: EMAIL },
    });
    const services = makeServices({ userInput: vaultWithEmail() });
    const tool = wrapTool(spec(run), services);

    const result = await tool.execute({ q: 'a' }, undefined);

    expect(result.modelText).not.toContain(EMAIL);
    expect(result.modelText).toContain('{{user:email:1}}');
    expect(JSON.stringify(result.details)).not.toContain(EMAIL);
  });

  it('passes params through untouched when no vault is wired (vault-less fixtures)', async () => {
    const received: string[] = [];
    const run = async (params: { q: string }): Promise<DomainResult> => {
      received.push(params.q);
      return OK;
    };
    const tool = wrapTool(spec(run as ToolWrapperSpec['run']), makeServices());

    await tool.execute({ q: 'plain {{user:email:1}} text' }, undefined);

    expect(received).toEqual(['plain {{user:email:1}} text']);
  });

  it('leaves model-invented placeholders unresolved (nothing to leak)', async () => {
    const received: string[] = [];
    const run = async (params: { q: string }): Promise<DomainResult> => {
      received.push(params.q);
      return OK;
    };
    const services = makeServices({ userInput: vaultWithEmail() });
    const tool = wrapTool(spec(run as ToolWrapperSpec['run']), services);

    await tool.execute({ q: 'try {{user:ssn:9}}' }, undefined);

    expect(received).toEqual(['try {{user:ssn:9}}']);
  });
});

describe('@no-llm middleware model-supplied value preservation', () => {
  const TRACKING = '874426145172';

  it('does not redact a value the model supplied in the same call', async () => {
    // Regression: browser_navigate to `?tracknumbers=874426145172` returned
    // `?tracknumbers=[redacted-phone]`. The agent could not confirm its own
    // action had worked, retried, and finally reported a substitution failure
    // that had never happened.
    const run = async (): Promise<DomainResult> => ({
      ok: true,
      model: { url: `https://www.fedex.com/wtrk/track/?tracknumbers=${TRACKING}` },
    });
    const services = makeServices({ modelValues: new ModelSuppliedValues() });
    const tool = wrapTool(spec(run), services);

    const result = await tool.execute(
      { q: `https://www.fedex.com/fedextrack/?tracknumbers=${TRACKING}` },
      undefined,
    );

    expect(result.modelText).toContain(TRACKING);
    expect(result.modelText).not.toContain('[redacted-phone]');
  });

  it('preserves the value across later calls that never mention it', async () => {
    // Run scope, not call scope: the page carrying the answer is observed
    // several calls after the number was typed, and browser_observe takes no
    // parameters at all.
    const modelValues = new ModelSuppliedValues();
    const services = makeServices({ modelValues });
    const navigate = wrapTool(
      spec(async (): Promise<DomainResult> => OK),
      services,
    );
    await navigate.execute({ q: `https://example.com/track?id=${TRACKING}` }, undefined);

    const observe = wrapTool(
      spec(
        async (): Promise<DomainResult> => ({
          ok: true,
          model: { digest: `Package ${TRACKING} was delivered.` },
        }),
      ),
      services,
    );
    const result = await observe.execute({ q: 'observe' }, undefined);

    expect(result.modelText).toContain(TRACKING);
  });

  it('still redacts third-party PII the model never supplied', async () => {
    const run = async (): Promise<DomainResult> => ({
      ok: true,
      model: { digest: `Signed for by john.doe@example.com, call 415-555-0142.` },
    });
    const services = makeServices({ modelValues: new ModelSuppliedValues() });
    const tool = wrapTool(spec(run), services);

    const result = await tool.execute({ q: `track ${TRACKING}` }, undefined);

    expect(result.modelText).not.toContain('john.doe@example.com');
    expect(result.modelText).not.toContain('415-555-0142');
  });
});
