// @no-llm
import type { ClickStep, FillStep } from '@yantra/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { InMemoryCaptureStore } from '../../../src/executor/capture-store.js';
import { handleClick } from '../../../src/executor/step-handlers/click.js';
import {
  SELECT_ALL_MODIFIER,
  handleFill,
  selectExistingValue,
} from '../../../src/executor/step-handlers/fill.js';
import type { ExecutionContext } from '../../../src/executor/types.js';
import { ValueResolver } from '../../../src/executor/value-resolver.js';

const locator = vi.hoisted(() => vi.fn());
vi.mock('../../../src/executor/step-handlers/locator-helpers.js', () => ({
  resolveLocatorChain: locator,
}));

describe('@no-llm Puppeteer input migration boundary', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    locator.mockReset();
  });

  it.each([null, ['Alt'] as const])(
    'dispatches exactly one click when modifiers are %s',
    async (modifiers) => {
      const emitted: string[] = [];
      const handle = elementHandle({
        click: async (options: { readonly count?: number }) => {
          for (let index = 0; index < (options.count ?? 1); index += 1) emitted.push('click');
        },
      });
      locator.mockResolvedValue({ kind: 'found', elementHandle: handle, chainName: 'button' });

      const result = await handleClick(clickStep(modifiers), context());

      expect(result).toEqual({ kind: 'completed' });
      expect(emitted).toEqual(['click']);
    },
  );

  it('always releases the select-all modifier when selection dispatch fails', async () => {
    const events: string[] = [];
    const page = keyboardPage({
      down: async (key: string) => events.push(`down:${key}`),
      press: async () => {
        events.push('press:a');
        throw new Error('selection dispatch failed');
      },
      up: async (key: string) => events.push(`up:${key}`),
    });

    await expect(selectExistingValue(elementHandle(), page)).rejects.toThrow(
      'selection dispatch failed',
    );
    expect(events).toEqual([`down:${SELECT_ALL_MODIFIER}`, 'press:a', `up:${SELECT_ALL_MODIFIER}`]);
  });

  it.each([
    { failure: 'typing', submit: false },
    { failure: 'submit', submit: true },
  ])('zeroes a secret exactly once after a $failure failure', async ({ failure, submit }) => {
    const zero = vi.fn();
    vi.spyOn(ValueResolver.prototype, 'resolveSecret').mockResolvedValue({
      plaintext: 'CANARY-plaintext',
      zero,
    });
    const handle = elementHandle({
      type:
        failure === 'typing'
          ? async () => {
              throw new Error('typing failed');
            }
          : async () => undefined,
      press:
        failure === 'submit'
          ? async () => {
              throw new Error('submit failed');
            }
          : async () => undefined,
    });
    locator.mockResolvedValue({ kind: 'found', elementHandle: handle, chainName: 'field' });

    const result = await handleFill(fillStep(submit), context());

    expect(result).toMatchObject({ kind: 'failed', failureClass: 'unexpected' });
    expect(zero).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain('CANARY-plaintext');
  });

  it('returns a secret-free completed result after keyboard selection and typing', async () => {
    const zero = vi.fn();
    vi.spyOn(ValueResolver.prototype, 'resolveSecret').mockResolvedValue({
      plaintext: 'CANARY-plaintext',
      zero,
    });
    locator.mockResolvedValue({
      kind: 'found',
      elementHandle: elementHandle(),
      chainName: 'field',
    });

    const result = await handleFill(fillStep(false), context());

    expect(result).toEqual({ kind: 'completed' });
    expect(zero).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain('CANARY-plaintext');
  });
});

function elementHandle(overrides: Record<string, unknown> = {}): never {
  return {
    focus: vi.fn().mockResolvedValue(undefined),
    click: vi.fn().mockResolvedValue(undefined),
    type: vi.fn().mockResolvedValue(undefined),
    press: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as never;
}

function keyboardPage(
  overrides: {
    readonly down?: (key: string) => Promise<unknown>;
    readonly press?: (key: string) => Promise<unknown>;
    readonly up?: (key: string) => Promise<unknown>;
  } = {},
): never {
  return {
    keyboard: {
      down: overrides.down ?? vi.fn().mockResolvedValue(undefined),
      press: overrides.press ?? vi.fn().mockResolvedValue(undefined),
      up: overrides.up ?? vi.fn().mockResolvedValue(undefined),
    },
  } as never;
}

function context(): ExecutionContext {
  return {
    captures: new InMemoryCaptureStore(),
    params: {},
    secrets: { resolve: vi.fn() },
    locatorHost: {},
    page: { puppeteerPage: keyboardPage() },
    settler: null,
    budgets: { canRetry: () => false },
    taskId: 'task',
    runId: 'run',
  } as unknown as ExecutionContext;
}

function clickStep(modifiers: ClickStep['modifiers']): ClickStep {
  return {
    id: 'click',
    type: 'click',
    scope: null,
    requires_confirmation: false,
    confirmation_description: null,
    expected_cost: null,
    consequence: null,
    locator: { kind: 'workflow', name: 'button' },
    modifiers,
  };
}

function fillStep(submit: boolean): FillStep {
  return {
    id: 'fill',
    type: 'fill',
    scope: null,
    requires_confirmation: false,
    confirmation_description: null,
    expected_cost: null,
    consequence: null,
    locator: { kind: 'workflow', name: 'field' },
    value: { kind: 'secret', key: 'fixture.password' },
    submit,
  };
}
