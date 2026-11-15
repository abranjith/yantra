// @no-llm
/**
 * FEAT-069 TASK-003: deterministic fills protect the live view.
 *
 * - A secret fill latches the run's SensitiveScreenLatch after the secret
 *   resolves and before any character is dispatched; a failing fill leaves it set.
 * - A literal fill into a protected control (a masked-value fill) holds
 *   protection for the fill's duration only, released on success and on throw.
 * - A plain fill does neither.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FillElementStep, FillStep, Plan, Step } from '@yantra/protocol';
import { SCHEMA_VERSION } from '@yantra/protocol';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { LocalProfileStore } from '../../src/browser/profile-store.js';
import { LocalBrowserProvider } from '../../src/browser/provider.js';
import { ScreenProtection } from '../../src/browser/screen-protection.js';
import { SensitiveScreenLatch } from '../../src/browser/sensitive-screen-latch.js';
import type { BrowserSession, Logger, Page } from '../../src/browser/types.js';
import { InMemoryCaptureStore } from '../../src/executor/capture-store.js';
import { createExecutionContext } from '../../src/executor/execution-context.js';
import {
  driveFillElement,
  handleFillElement,
} from '../../src/executor/step-handlers/fill-element.js';
import { handleFill } from '../../src/executor/step-handlers/fill.js';
import { realClock, type ExecutionContext, type StepResult } from '../../src/executor/types.js';
import type { EngineLocatorChain } from '../../src/locator/types.js';
import type { WidgetTarget } from '../../src/widgets/types.js';
import {
  beginMigrationBrowserFixture,
  type MigrationBrowserFixture,
} from '../helpers/migration-browser.js';
import { WidgetTestPort } from '../support/widget-test-port.js';

const CANARY = 'CANARY-fill-protection';

function protectedContext(secrets: ExecutionContext['secrets'] = null): ExecutionContext & {
  sensitiveScreenLatch: SensitiveScreenLatch;
  screenProtection: ScreenProtection;
} {
  const sensitiveScreenLatch = new SensitiveScreenLatch();
  const screenProtection = new ScreenProtection(sensitiveScreenLatch);
  return {
    captures: new InMemoryCaptureStore(),
    params: {},
    secrets,
    budgets: { canRetry: () => false },
    clock: realClock,
    settler: null,
    sensitiveScreenLatch,
    screenProtection,
  } as unknown as ExecutionContext & {
    sensitiveScreenLatch: SensitiveScreenLatch;
    screenProtection: ScreenProtection;
  };
}

function semanticStep(value: FillElementStep['value'], fieldName = 'Password'): FillElementStep {
  return {
    id: 'fill-element',
    type: 'fill_element',
    scope: null,
    requires_confirmation: false,
    confirmation_description: null,
    expected_cost: null,
    consequence: null,
    field_name: fieldName,
    locator: { kind: 'workflow', name: 'Field' },
    value,
  };
}

function legacyStep(value: FillStep['value']): FillStep {
  return {
    id: 'fill',
    type: 'fill',
    scope: null,
    requires_confirmation: false,
    confirmation_description: null,
    expected_cost: null,
    consequence: null,
    locator: { kind: 'workflow', name: 'Field' },
    value,
    submit: false,
  };
}

function targetOf(port: WidgetTestPort, selector: string, name: string): WidgetTarget {
  return { ref: port.refFor(selector), role: 'textbox', name, group: null, value: null };
}

/** Records `isProtectedNow` at every port write. */
function recordProtectionAtWrites(
  port: WidgetTestPort,
  screen: ScreenProtection,
): { readonly during: boolean[] } {
  const during: boolean[] = [];
  for (const method of ['fill', 'type', 'clear'] as const) {
    const original = port[method].bind(port) as (...args: unknown[]) => Promise<void>;
    vi.spyOn(port, method).mockImplementation(async (...args: unknown[]) => {
      during.push(screen.isProtectedNow);
      await original(...args);
    });
  }
  return { during };
}

describe('@no-llm driveFillElement screen protection', () => {
  it('latches after the secret resolves and before any write reaches the page', async () => {
    const port = new WidgetTestPort('<input id="pw" type="password" aria-label="Password">');
    const resolve = vi.fn().mockResolvedValue(CANARY);
    const ctx = protectedContext({ resolve });
    const latch = vi.spyOn(ctx.sensitiveScreenLatch, 'latch');
    const writes = [vi.spyOn(port, 'fill'), vi.spyOn(port, 'type'), vi.spyOn(port, 'clear')];

    const result = await driveFillElement(
      semanticStep({ kind: 'secret', key: 'site.password' }),
      ctx,
      port,
      targetOf(port, '#pw', 'Password'),
    );

    expect(result).toMatchObject({ kind: 'completed' });
    expect(latch).toHaveBeenCalledTimes(1);
    const firstWrite = Math.min(...writes.flatMap((spy) => spy.mock.invocationCallOrder));
    expect(Number.isFinite(firstWrite)).toBe(true);
    expect(resolve.mock.invocationCallOrder[0]).toBeLessThan(latch.mock.invocationCallOrder[0]!);
    expect(latch.mock.invocationCallOrder[0]).toBeLessThan(firstWrite);
    expect(ctx.sensitiveScreenLatch.isLatched(null)).toBe(true);
    expect(ctx.screenProtection.isProtectedNow).toBe(true);
  });

  it('latches at the settler epoch when one exists, so the next navigation clears it', async () => {
    const port = new WidgetTestPort('<input id="pw" type="password" aria-label="Password">');
    const ctx = protectedContext({ resolve: vi.fn().mockResolvedValue(CANARY) });
    (ctx as { settler: unknown }).settler = { epoch: 6 };
    await driveFillElement(
      semanticStep({ kind: 'secret', key: 'site.password' }),
      ctx,
      port,
      targetOf(port, '#pw', 'Password'),
    );
    expect(ctx.sensitiveScreenLatch.isLatched(6)).toBe(true);
    expect(ctx.sensitiveScreenLatch.isLatched(7)).toBe(false);
  });

  it('leaves the latch set when the secret fill throws mid-dispatch', async () => {
    const port = new WidgetTestPort('<input id="pw" type="password" aria-label="Password">');
    const ctx = protectedContext({ resolve: vi.fn().mockResolvedValue(CANARY) });
    vi.spyOn(port, 'type').mockRejectedValue(new Error('page crashed'));
    vi.spyOn(port, 'fill').mockRejectedValue(new Error('page crashed'));

    await expect(
      driveFillElement(
        semanticStep({ kind: 'secret', key: 'site.password' }),
        ctx,
        port,
        targetOf(port, '#pw', 'Password'),
      ),
    ).rejects.toThrow('page crashed');
    expect(ctx.sensitiveScreenLatch.isLatched(null)).toBe(true);
  });

  it('does not latch when the secret cannot be resolved (nothing reaches the page)', async () => {
    const port = new WidgetTestPort('<input id="pw" type="password" aria-label="Password">');
    const ctx = protectedContext({ resolve: vi.fn().mockRejectedValue(new Error('no key')) });
    const result = await driveFillElement(
      semanticStep({ kind: 'secret', key: 'site.password' }),
      ctx,
      port,
      targetOf(port, '#pw', 'Password'),
    );
    expect(result.kind).toBe('failed');
    expect(ctx.sensitiveScreenLatch.isLatched(null)).toBe(false);
  });

  it('holds protection during a masked-value fill and releases it on success', async () => {
    const port = new WidgetTestPort('<input id="pw" type="password" aria-label="Password">');
    const ctx = protectedContext();
    const { during } = recordProtectionAtWrites(port, ctx.screenProtection);
    const seen: boolean[] = [];
    ctx.screenProtection.subscribe((value) => seen.push(value));

    const result = await driveFillElement(
      semanticStep({ kind: 'literal', value: 'Synth3tic!pw' }),
      ctx,
      port,
      targetOf(port, '#pw', 'Password'),
      { protectedTarget: true },
    );

    expect(result).toMatchObject({ kind: 'completed' });
    expect(during.length).toBeGreaterThan(0);
    expect(during.every(Boolean)).toBe(true);
    expect(ctx.screenProtection.isProtectedNow).toBe(false);
    expect(ctx.screenProtection.openHolds).toBe(0);
    expect(seen).toEqual([true, false]);
    // A masked-value fill holds; it does not latch.
    expect(ctx.sensitiveScreenLatch.isLatched(null)).toBe(false);
  });

  it('releases the masked-value hold when the fill throws', async () => {
    const port = new WidgetTestPort('<input id="pw" type="password" aria-label="Password">');
    const ctx = protectedContext();
    vi.spyOn(port, 'type').mockRejectedValue(new Error('detached'));
    vi.spyOn(port, 'fill').mockRejectedValue(new Error('detached'));

    await expect(
      driveFillElement(
        semanticStep({ kind: 'literal', value: 'Synth3tic!pw' }),
        ctx,
        port,
        targetOf(port, '#pw', 'Password'),
        { protectedTarget: true },
      ),
    ).rejects.toThrow('detached');
    expect(ctx.screenProtection.openHolds).toBe(0);
    expect(ctx.screenProtection.isProtectedNow).toBe(false);
  });

  it('releases the masked-value hold when the engine reports a failure', async () => {
    const port = new WidgetTestPort('<button id="b" aria-label="Password">Password</button>');
    const ctx = protectedContext();
    const result = await driveFillElement(
      semanticStep({ kind: 'literal', value: 'text' }),
      ctx,
      port,
      { ...targetOf(port, '#b', 'Password'), role: 'button' },
      { protectedTarget: true },
    );
    expect(result.kind).toBe('failed');
    expect(ctx.screenProtection.openHolds).toBe(0);
  });

  it('neither latches nor holds for a plain fill', async () => {
    const port = new WidgetTestPort('<input id="q" aria-label="Query">');
    const ctx = protectedContext();
    const { during } = recordProtectionAtWrites(port, ctx.screenProtection);
    const seen: boolean[] = [];
    ctx.screenProtection.subscribe((value) => seen.push(value));

    const result = await driveFillElement(
      semanticStep({ kind: 'literal', value: 'Blue' }, 'Query'),
      ctx,
      port,
      targetOf(port, '#q', 'Query'),
    );

    expect(result).toMatchObject({ kind: 'completed' });
    expect(during.length).toBeGreaterThan(0);
    expect(during.some(Boolean)).toBe(false);
    expect(seen).toEqual([]);
    expect(ctx.sensitiveScreenLatch.isLatched(null)).toBe(false);
  });

  it('still fills when the context carries no protection (hand-built contexts)', async () => {
    const port = new WidgetTestPort('<input id="pw" type="password" aria-label="Password">');
    const ctx = {
      ...protectedContext({ resolve: vi.fn().mockResolvedValue(CANARY) }),
      sensitiveScreenLatch: undefined,
      screenProtection: undefined,
    } as unknown as ExecutionContext;
    await expect(
      driveFillElement(
        semanticStep({ kind: 'literal', value: 'x' }),
        ctx,
        port,
        targetOf(port, '#pw', 'Password'),
        { protectedTarget: true },
      ),
    ).resolves.toMatchObject({ kind: 'completed' });
    await expect(
      driveFillElement(
        semanticStep({ kind: 'secret', key: 'k' }),
        ctx,
        port,
        targetOf(port, '#pw', 'Password'),
      ),
    ).resolves.toMatchObject({ kind: 'completed' });
  });
});

describe('@no-llm createExecutionContext screen protection', () => {
  it('gives every replay context its own latch and protection', async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'yantra-fill-protection-ctx-'));
    try {
      const make = () =>
        createExecutionContext({
          taskId: '01JEXAMPLETASKID0000000000',
          plan: planOf(legacyStep({ kind: 'literal', value: 'x' })),
          runDir,
          ethics: { check: () => Promise.resolve() },
          logger: silentLogger,
        });
      const first = make();
      const second = make();
      expect(first.sensitiveScreenLatch).toBeInstanceOf(SensitiveScreenLatch);
      expect(first.screenProtection?.latch).toBe(first.sensitiveScreenLatch);
      expect(second.sensitiveScreenLatch).not.toBe(first.sensitiveScreenLatch);
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  });
});

const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

function planOf(step: Step): Plan {
  return {
    task_id: '01JEXAMPLETASKID0000000000',
    plan_id: '01JEXAMPLEPLANID0000000000',
    schema_version: SCHEMA_VERSION,
    default_scope: 'public',
    steps: [step],
    outputs: [],
  };
}

describe('@no-llm deterministic fill handlers protect the screen (real Chrome)', () => {
  let fixture: MigrationBrowserFixture;
  let session: BrowserSession;
  let page: Page;
  const runDirs: string[] = [];

  beforeAll(async () => {
    fixture = await beginMigrationBrowserFixture();
    session = await new LocalBrowserProvider({
      profileStore: new LocalProfileStore(),
      logger: silentLogger,
    }).launch({ profile: { kind: 'ephemeral' }, headless: true, ...fixture.launchOptions });
    page = await session.newPage();
  }, 60_000);

  afterAll(async () => {
    await session?.close();
    await fixture?.cleanup();
    await Promise.all(runDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  async function run<TStep extends Step>(
    step: TStep,
    handler: (step: TStep, context: ExecutionContext) => Promise<StepResult>,
    secrets: ExecutionContext['secrets'] = null,
  ): Promise<{ readonly result: StepResult; readonly context: ExecutionContext }> {
    const runDir = await mkdtemp(join(tmpdir(), 'yantra-fill-protection-'));
    runDirs.push(runDir);
    const context = createExecutionContext({
      taskId: '01JEXAMPLETASKID0000000000',
      plan: planOf(step),
      runDir,
      browser: session,
      page,
      ethics: { check: () => Promise.resolve() },
      logger: silentLogger,
      secrets,
      workflowLocators: {
        resolve: (): EngineLocatorChain => ({
          name: 'Field',
          strict: true,
          candidates: [{ source: 'authored', intent: { kind: 'css', selector: '#field' } }],
        }),
      },
    });
    return { result: await handler(step, context), context };
  }

  it('latches a legacy fill secret before the keyboard types it', async () => {
    await page.puppeteerPage!.setContent('<input id="field" type="password" aria-label="Field">');
    const keyboard = page.puppeteerPage!.keyboard;
    const typed = vi.spyOn(keyboard, 'type');
    const latched = vi.spyOn(SensitiveScreenLatch.prototype, 'latch');
    try {
      const { result, context } = await run(
        legacyStep({ kind: 'secret', key: 'fixture.password' }),
        handleFill,
        { resolve: async () => CANARY },
      );
      expect(result).toEqual({ kind: 'completed' });
      expect(latched).toHaveBeenCalledTimes(1);
      expect(typed).toHaveBeenCalled();
      expect(latched.mock.invocationCallOrder[0]).toBeLessThan(typed.mock.invocationCallOrder[0]!);
      expect(context.sensitiveScreenLatch?.isLatched(context.settler?.epoch)).toBe(true);
      expect(JSON.stringify(result)).not.toContain(CANARY);
    } finally {
      typed.mockRestore();
      latched.mockRestore();
    }
  }, 30_000);

  it('keeps a legacy secret fill latched when the fill fails', async () => {
    await page.puppeteerPage!.setContent('<input id="field" type="password" aria-label="Field">');
    const keyboard = page.puppeteerPage!.keyboard;
    const typed = vi.spyOn(keyboard, 'type').mockRejectedValue(new Error('target closed'));
    try {
      const { result, context } = await run(
        legacyStep({ kind: 'secret', key: 'fixture.password' }),
        handleFill,
        { resolve: async () => CANARY },
      );
      expect(result.kind).toBe('failed');
      expect(context.sensitiveScreenLatch?.isLatched(null)).toBe(true);
    } finally {
      typed.mockRestore();
    }
  }, 30_000);

  it('neither latches nor holds for a legacy plain fill', async () => {
    await page.puppeteerPage!.setContent('<input id="field" aria-label="Field">');
    const { result, context } = await run(
      legacyStep({ kind: 'literal', value: 'plain' }),
      handleFill,
    );
    expect(result).toEqual({ kind: 'completed' });
    expect(context.screenProtection?.isProtectedNow).toBe(false);
  }, 30_000);

  it('holds during a semantic literal fill into a password field, then releases', async () => {
    await page.puppeteerPage!.setContent(
      '<label>Password <input id="field" type="password"></label>',
    );
    const keyboard = page.puppeteerPage!.keyboard;
    const during: boolean[] = [];
    const holds = vi.spyOn(ScreenProtection.prototype, 'hold');
    const original = keyboard.type.bind(keyboard);
    const typed = vi.spyOn(keyboard, 'type').mockImplementation(async (...args) => {
      // `mock.contexts` holds the `this` of each hold() call.
      during.push(
        (holds.mock.contexts[0] as ScreenProtection | undefined)?.isProtectedNow ?? false,
      );
      await original(...args);
    });
    try {
      const { result, context } = await run(
        semanticStep({ kind: 'literal', value: 'Synth3tic!pw' }),
        handleFillElement,
      );
      expect(result).toMatchObject({
        kind: 'completed',
        details: { withheld: { reason: 'password' } },
      });
      expect(holds).toHaveBeenCalledWith('masked_fill');
      expect(holds.mock.contexts[0]).toBe(context.screenProtection);
      expect(during.length).toBeGreaterThan(0);
      expect(during.every(Boolean)).toBe(true);
      expect(context.screenProtection?.isProtectedNow).toBe(false);
      expect(context.sensitiveScreenLatch?.isLatched(null)).toBe(false);
    } finally {
      typed.mockRestore();
      holds.mockRestore();
    }
  }, 30_000);

  it('latches a semantic secret fill and does not hold for a plain semantic fill', async () => {
    await page.puppeteerPage!.setContent(
      '<label>Password <input id="field" type="password"></label>',
    );
    const secret = await run(
      semanticStep({ kind: 'secret', key: 'fixture.password' }),
      handleFillElement,
      {
        resolve: async () => CANARY,
      },
    );
    expect(secret.result).toMatchObject({ kind: 'completed' });
    expect(secret.context.sensitiveScreenLatch?.isLatched(null)).toBe(true);

    await page.puppeteerPage!.setContent('<label>Query <input id="field"></label>');
    const holds = vi.spyOn(ScreenProtection.prototype, 'hold');
    try {
      const plain = await run(
        semanticStep({ kind: 'literal', value: 'Blue' }, 'Query'),
        handleFillElement,
      );
      expect(plain.result).toMatchObject({ kind: 'completed' });
      expect(holds).not.toHaveBeenCalled();
      expect(plain.context.screenProtection?.isProtectedNow).toBe(false);
    } finally {
      holds.mockRestore();
    }
  }, 30_000);
});
