// @no-llm
import type { FillElementStep } from '@yantra/protocol';
import { layoutMatrix } from '@yantra/test-helpers/layout-matrix';
import { describe, expect, it, vi } from 'vitest';

import { wrapPuppeteerPage } from '../../src/browser/session.js';
import { promoteAgentTrace, type PromotableTraceStep } from '../../src/discovery/promote.js';
import { InMemoryCaptureStore } from '../../src/executor/capture-store.js';
import {
  describeReplayHandle,
  driveFillElement,
  handleFillElement,
  FillElementExecutionError,
} from '../../src/executor/step-handlers/fill-element.js';
import { STEP_DISPATCH } from '../../src/executor/step-handlers/index.js';
import { realClock, type ExecutionContext } from '../../src/executor/types.js';
import { classifyWithheld } from '../../src/interaction/protected-value.js';
import type { WidgetTarget } from '../../src/widgets/types.js';
import { translate } from '../../src/workflow/replay/workflow-to-plan.js';
import type { WorkflowStore } from '../../src/workflow/store.types.js';
import { layoutBrowser } from '../helpers/layout-browser.js';
import { protectedInputMarkup, WITHHELD_FACTS_TABLE } from '../support/protected-facts.js';
import { WidgetTestPort } from '../support/widget-test-port.js';

describe('@no-llm fill_element replay handler', () => {
  it('replays promoted structural fields and refuses legacy widening before locator fallback', async () => {
    const browser = await layoutBrowser();
    try {
      const fixture = layoutMatrix.find((item) => item.id === 'table-label-cell')!;
      await browser.page.setContent(fixture.html());
      const observation = await browser.controller.observe();
      const trace: PromotableTraceStep[] = [];
      for (const entry of observation.interactables) {
        await browser.controller.fill(entry.ref, 'Synthetic');
        trace.push({
          kind: 'fill_element',
          host: '',
          field: {
            role: entry.role,
            name: entry.name,
            group: null,
            label: entry.field!.label!,
            label_origin: entry.field!.origin,
          },
          locator: [{ kind: 'css', value: 'input' }],
          value: { kind: 'literal', value: 'Synthetic' },
          requires_confirmation: false,
        });
      }
      const store = { save: async () => undefined } as unknown as WorkflowStore;
      const promoted = await promoteAgentTrace(trace, { workflowName: 'structural-replay', store });
      expect(promoted.isOk).toBe(true);
      if (!promoted.isOk) return;
      const plan = translate(promoted.value, {}).plan;
      await browser.page.setContent(fixture.html());
      const facade = wrapPuppeteerPage(browser.page);
      const ctx = {
        ...context(),
        page: facade,
        locatorHost: facade.locatorHost,
      } as ExecutionContext;
      for (const step of plan.steps) {
        if (step.type !== 'fill_element') throw new Error('Expected a semantic fill');
        expect(await handleFillElement(step, ctx)).toMatchObject({ kind: 'completed' });
      }
      for (const control of fixture.controls)
        expect(
          await browser.page.$eval(
            `[data-fixture-key="${control.key}"]`,
            (element) => (element as HTMLInputElement).value,
          ),
        ).toBe('Synthetic');
      await browser.page.setContent(fixture.html());
      const first = plan.steps[0]!;
      if (first.type !== 'fill_element') throw new Error('Expected a semantic fill');
      const { field_label_origin: _origin, ...legacy } = first;
      const result = await handleFillElement(legacy, ctx);
      expect(result).toMatchObject({
        kind: 'failed',
        error: { code: 'WIDGET_TARGET_UNREACHABLE' },
      });
      expect(await browser.page.$eval('input', (element) => element.value)).toBe('');
    } finally {
      await browser.close();
    }
  }, 45_000);
  it('classifies a control the scan kept no record for with the shared vocabulary', async () => {
    // `role="tab"` keeps the scan from describing the input, so the replay
    // port's own in-page describer answers. Its private predicate once omitted
    // the secret marker; it now has to agree with the shared classifier on
    // every row, in a real page where it cannot close over anything.
    const browser = await layoutBrowser();
    try {
      for (const row of WITHHELD_FACTS_TABLE) {
        await browser.page.setContent(protectedInputMarkup(row, 'CANARY-replay', 'role="tab"'));
        const handle = (await browser.page.$('input'))!;
        try {
          const described = await describeReplayHandle(handle);
          expect({ row: row.label, withheld: described?.withheld ?? null }).toEqual({
            row: row.label,
            withheld: classifyWithheld(row.facts),
          });
          if (row.expected === null) {
            expect(described?.value).toBe('CANARY-replay');
          } else {
            expect(described?.value_present).toBe(true);
            expect(JSON.stringify(described)).not.toContain('CANARY-replay');
          }
        } finally {
          await handle.dispose();
        }
      }
    } finally {
      await browser.close();
    }
  }, 45_000);

  it('is registered in the executor dispatch table', () => {
    expect(STEP_DISPATCH.has('fill_element')).toBe(true);
  });

  it('resolves embedded params and returns the verified committed range', async () => {
    const port = new WidgetTestPort(
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
    const port = new WidgetTestPort('<input id="password" type="password" aria-label="Password">');
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

  it('preserves the native select branch and commits the offered option value', async () => {
    const port = new WidgetTestPort(
      '<select id="country" aria-label="Country">' +
        '<option value="">Choose</option><option value="de">Germany</option></select>',
    );
    const result = await driveFillElement(
      fillStep({ kind: 'literal', value: 'Germany' }),
      context(),
      port,
      target(port, '#country', 'Country', 'combobox'),
    );

    expect(result).toMatchObject({
      kind: 'completed',
      details: { committed: 'Germany', driver: 'native-select' },
    });
  });

  it('surfaces typed engine failures without an LLM fallback', async () => {
    const port = new WidgetTestPort('<button id="action" aria-label="Action">Action</button>');
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
    const port = new WidgetTestPort('<button id="action" aria-label="Action">Action</button>');
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
  port: WidgetTestPort,
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
