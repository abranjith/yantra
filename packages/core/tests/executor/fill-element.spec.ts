// @no-llm
import type { FillElementStep } from '@yantra/protocol';
import { describe, expect, it, vi } from 'vitest';

import { InMemoryCaptureStore } from '../../src/executor/capture-store.js';
import {
  driveFillElement,
  FillElementExecutionError,
} from '../../src/executor/step-handlers/fill-element.js';
import { STEP_DISPATCH } from '../../src/executor/step-handlers/index.js';
import { realClock, type ExecutionContext } from '../../src/executor/types.js';
import type { WidgetTarget } from '../../src/widgets/types.js';
import { CalendarTestPort } from '../widgets/calendar-test-port.js';

describe('@no-llm fill_element replay handler', () => {
  it('is registered in the executor dispatch table', () => {
    expect(STEP_DISPATCH.has('fill_element')).toBe(true);
  });

  it('resolves embedded params and returns the verified committed range', async () => {
    const port = new CalendarTestPort(
      '<input id="from" aria-label="Check-in" placeholder="MM/DD/YYYY">' +
        '<input id="to" aria-label="Check-out" placeholder="MM/DD/YYYY">',
    );
    const step = fillStep({
      kind: 'template',
      template: '{{from}}..{{to}}',
      bindings: {
        from: { kind: 'param', key: 'from' },
        to: { kind: 'param', key: 'to' },
      },
    });
    const result = await driveFillElement(
      step,
      context({ params: { from: '2026-08-21', to: '2026-08-22' } }),
      port,
      target(port, '#from', 'Check-in'),
    );

    expect(result).toMatchObject({
      kind: 'completed',
      details: {
        committed: '08/21/2026..08/22/2026',
        driver: 'date-input-range',
      },
    });
  });

  it('resolves a secret only at the handler boundary and omits it from the report', async () => {
    const port = new CalendarTestPort(
      '<input id="password" type="password" aria-label="Password">',
    );
    const resolve = vi.fn().mockResolvedValue('CANARY-super-secret');
    const result = await driveFillElement(
      fillStep({ kind: 'secret', key: 'site.password' }),
      context({ secrets: { resolve } }),
      port,
      target(port, '#password', 'Password'),
    );

    expect(result).toMatchObject({
      kind: 'completed',
      details: { driver: 'plain-text', dismissed: false },
    });
    expect(JSON.stringify(result)).not.toContain('CANARY-super-secret');
    expect(resolve).toHaveBeenCalledWith({ kind: 'secret', key: 'site.password' });
  });

  it('surfaces typed engine failures without an LLM fallback', async () => {
    const port = new CalendarTestPort('<button id="action" aria-label="Action">Action</button>');
    const result = await driveFillElement(
      fillStep({ kind: 'literal', value: 'text' }),
      context(),
      port,
      target(port, '#action', 'Action', 'button'),
    );

    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') return;
    expect(result.failureClass).toBe('locator_not_found');
    expect(result.error).toBeInstanceOf(FillElementExecutionError);
    expect((result.error as FillElementExecutionError).code).toBe('WIDGET_TARGET_UNREACHABLE');
  });

  it('returns a bounded retry for retryable widget state', async () => {
    const port = new CalendarTestPort('<button id="action" aria-label="Action">Action</button>');
    const result = await driveFillElement(
      fillStep({ kind: 'literal', value: 'text' }),
      context({ canRetry: true }),
      port,
      target(port, '#action', 'Action', 'button'),
    );

    expect(result).toMatchObject({
      kind: 'retried',
      reason: 'WIDGET_TARGET_UNREACHABLE',
    });
  });
});

function fillStep(value: FillElementStep['value']): FillElementStep {
  return {
    id: 's1',
    type: 'fill_element',
    scope: null,
    requires_confirmation: false,
    confirmation_description: null,
    expected_cost: null,
    consequence: null,
    field_name: 'Check-in',
    locator: { kind: 'workflow', name: 'Field' },
    value,
  };
}

function target(
  port: CalendarTestPort,
  selector: string,
  name: string,
  role = 'textbox',
): WidgetTarget {
  return { ref: port.refFor(selector), role, name, group: null, value: null };
}

function context(
  options: {
    readonly params?: Readonly<Record<string, unknown>>;
    readonly secrets?: ExecutionContext['secrets'];
    readonly canRetry?: boolean;
  } = {},
): ExecutionContext {
  return {
    captures: new InMemoryCaptureStore(),
    params: options.params ?? {},
    secrets: options.secrets ?? null,
    budgets: {
      canRetry: () => options.canRetry ?? false,
    },
    clock: realClock,
  } as unknown as ExecutionContext;
}
