/// <reference lib="dom" />

import type {
  AgentBrowserController,
  AgentBrowserObservation,
  AgentInteractable,
  WidgetErrorCode,
  WidgetFailure,
} from '@yantra/core';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';

import { browserPickDateSpec } from '../../../../src/adapters/pi/tools/browser-pick-date.js';
import { browserPickOptionSpec } from '../../../../src/adapters/pi/tools/browser-pick-option.js';
import { mapWidgetFailure } from '../../../../src/adapters/pi/tools/browser-widget-common.js';
import { wrapTool } from '../../../../src/runtime/middleware.js';
import { COMMAND_TASK_PROFILES } from '../../../../src/runtime/profiles.js';
import type { BrowserToolDeps } from '../../../../src/runtime/run-services.js';

import { allowingEthics, assertToolContract, buildServices } from './test-support.js';

describe('@no-llm browser_pick_option', () => {
  it('returns the verified commit and a post-action observation', async () => {
    const controller = new WidgetController(
      '<select id="trigger" aria-label="City"><option value="dfw">Dallas</option><option value="fr">Frisco</option></select>',
    );

    const result = await runOption(controller, { field: 'City', value: 'Frisco' });
    const model = JSON.parse(result.modelText) as Record<string, unknown>;

    expect(result.status).toBe('ok');
    expect(model).toMatchObject({ committed: 'Frisco', driver: 'native-select' });
    expect(model.interactables).toBeInstanceOf(Array);
  });

  it('preserves every widget error code and details verbatim', () => {
    const codes: WidgetErrorCode[] = [
      'WIDGET_NOT_RECOGNIZED',
      'WIDGET_DID_NOT_OPEN',
      'WIDGET_TARGET_UNREACHABLE',
      'WIDGET_AMBIGUOUS_CHOICE',
      'WIDGET_MAPPING_UNSAFE',
      'WIDGET_NOT_COMMITTED',
    ];
    for (const errorCode of codes) {
      const failure: WidgetFailure = {
        ok: false,
        errorCode,
        message: `failure ${errorCode}`,
        retryable: errorCode !== 'WIDGET_MAPPING_UNSAFE',
        details: { offered: ['A', 'B'], nested: { code: errorCode } },
      };
      expect(mapWidgetFailure(failure)).toEqual({
        ok: false,
        errorCode,
        message: failure.message,
        retryable: failure.retryable,
        details: failure.details,
      });
    }
  });

  it('refuses credential-shaped values before observing the page', async () => {
    const controller = new WidgetController('<select id="trigger" aria-label="City"></select>');
    const observe = vi.spyOn(controller, 'observe');

    const result = await runOption(controller, {
      field: 'City',
      value: 'sk-abcdefghijklmnopqrstuvwxyz',
    });

    expect(result.error_code).toBe('SECRET_SHAPED_LITERAL');
    expect(observe).not.toHaveBeenCalled();
  });

  it('remains subject to the mutating action-phase middleware', async () => {
    const controller = new WidgetController(
      '<select id="trigger" aria-label="City"><option>Frisco</option></select>',
    );
    const services = servicesFor(controller);
    services.actionPhase.close();

    const result = await wrapTool(browserPickOptionSpec(services), services).execute(
      { field: 'City', value: 'Frisco' },
      undefined,
    );

    expect(result.error_code).toBe('ACTION_PHASE_CLOSED');
    expect(controller.actionCount).toBe(0);
  });

  it('accepts a visible field name and an eNN ref', async () => {
    const byName = new WidgetController(
      '<select id="trigger" aria-label="City"><option>Frisco</option></select>',
    );
    expect((await runOption(byName, { field: 'City', value: 'Frisco' })).status).toBe('ok');

    const byRef = new WidgetController(
      '<select id="trigger" aria-label="City"><option>Frisco</option></select>',
    );
    expect((await runOption(byRef, { field: 'e1', value: 'Frisco' })).status).toBe('ok');
  });
});

describe('@no-llm browser_pick_date', () => {
  it('accepts a single date and a complete date range', async () => {
    const input = new WidgetController('<input id="trigger" type="date" aria-label="Check-in">');
    const single = await runDate(input, { field: 'Check-in', date: '2026-09-06' });
    expect(single.status).toBe('ok');

    const calendar = calendarController();
    const range = await runDate(calendar, {
      field: 'Dates',
      from: '2026-09-06',
      to: '2026-09-08',
    });
    expect(range.status).toBe('ok');
    expect(JSON.parse(range.modelText)).toMatchObject({
      committed: 'Sep 6, 2026 - Sep 8, 2026',
      driver: 'calendar-grid',
    });
  });

  it('rejects every mis-specified date/range shape before touching the page', async () => {
    const shapes: Record<string, unknown>[] = [
      { field: 'Dates', from: '2026-09-06' },
      { field: 'Dates', to: '2026-09-08' },
      { field: 'Dates' },
      { field: 'Dates', date: '2026-09-06', from: '2026-09-06', to: '2026-09-08' },
      { field: 'Dates', date: '2026-09-06', to: '2026-09-08' },
    ];
    // Collected per shape rather than asserted in the loop: vitest's `expect`
    // takes no message argument, so a bare assertion here would report only
    // that *some* shape failed, without naming it.
    const outcomes: Record<string, unknown>[] = [];
    for (const shape of shapes) {
      const controller = calendarController();
      const result = await runDate(controller, shape);
      outcomes.push({
        shape,
        errorCode: result.error_code,
        observations: controller.observationCount,
        actions: controller.actionCount,
      });
    }

    expect(outcomes).toEqual(
      shapes.map((shape) => ({
        shape,
        errorCode: 'INVALID_INPUT',
        observations: 0,
        actions: 0,
      })),
    );
  });

  it('exposes a provider-acceptable object root schema, not a top-level union', () => {
    // A top-level Type.Union serializes to `anyOf` with no `type`, which the
    // provider refuses with "schema must be a JSON Schema of 'type: object'".
    const schema = browserPickDateSpec(buildServices()).parameters as {
      type?: string;
      anyOf?: unknown;
      required?: string[];
    };

    expect(schema.type).toBe('object');
    expect(schema.anyOf).toBeUndefined();
    expect(schema.required).toEqual(['field']);
  });

  it('satisfies the shared wrapper contract', async () => {
    const services = buildServices();
    await assertToolContract(browserPickDateSpec(services), { field: 'Dates', date: 'tomorrow' });
    await assertToolContract(browserPickOptionSpec(services), { field: 5, value: 'Frisco' });
  });

  it('rejects impossible and descending dates before page interaction', async () => {
    const impossible = new WidgetController('<input id="trigger" type="date" aria-label="Date">');
    const invalid = await runDate(impossible, { field: 'Date', date: '2026-02-31' });
    expect(invalid.error_code).toBe('INVALID_INPUT');
    expect(impossible.observationCount).toBe(0);

    const descending = calendarController();
    const range = await runDate(descending, {
      field: 'Dates',
      from: '2026-09-08',
      to: '2026-09-06',
    });
    expect(range.error_code).toBe('INVALID_INPUT');
    expect(descending.observationCount).toBe(0);
  });

  it('surfaces unsafe mapping details unchanged', async () => {
    const failure = mapWidgetFailure({
      ok: false,
      errorCode: 'WIDGET_MAPPING_UNSAFE',
      message: 'unsafe',
      retryable: true,
      details: { derived: 6, column: 5 },
    });

    expect(failure).toMatchObject({
      errorCode: 'WIDGET_MAPPING_UNSAFE',
      details: { derived: 6, column: 5 },
    });
  });

  /**
   * Regression for run 20260808T033702Z-do-a11ab916, where six `pick_date`
   * calls returned `STALE_ELEMENT_REF` naming refs (`e135`, `e496`, `e762`, …)
   * the model had never seen — it passed the name `"Dates"`. The trigger's ref
   * is minted internally and the page replaces the node when the picker opens,
   * so recovering from that is the tool's job, not the model's.
   */
  describe('a trigger the page replaces mid-drive', () => {
    it('re-acquires it by name and still commits', async () => {
      const controller = expediaShapedCalendar();
      controller.replaceElementOnClick('#trigger');

      const result = await runDate(controller, {
        field: 'Dates',
        from: '2026-09-06',
        to: '2026-09-08',
      });

      expect(result.status).toBe('ok');
      expect(JSON.parse(result.modelText)).toMatchObject({
        committed: 'Dates, Sep 6, 2026 - Sep 8, 2026',
        driver: 'calendar-grid',
      });
    });

    it('re-acquires it even when the caller passed a ref, not a name', async () => {
      const controller = expediaShapedCalendar();
      const { interactables } = await controller.observe();
      const ref = interactables.find((entry) => entry.name.startsWith('Dates'))!.ref;
      controller.replaceElementOnClick('#trigger');

      const result = await runDate(controller, {
        field: ref,
        from: '2026-09-06',
        to: '2026-09-08',
      });

      expect(result.status).toBe('ok');
    });

    /**
     * Some pickers replace the trigger's whole name with the committed value
     * ("Check-in" becomes "Sep 6"), leaving nothing to re-acquire by. That is
     * not recoverable in-call — but it must still read as a transient page
     * event the model can retry, not as a bad argument it should fix.
     */
    it('reports an unrecoverable replacement as a widget failure, never as a stale ref', async () => {
      const controller = expediaShapedCalendar();
      controller.replaceElementOnClick('#trigger', (element) => {
        element.setAttribute('aria-label', 'Sep 6, 2026');
      });

      const result = await runDate(controller, {
        field: 'Dates',
        from: '2026-09-06',
        to: '2026-09-08',
      });
      const model = JSON.parse(result.modelText) as Record<string, unknown>;

      expect(result.status).toBe('error');
      expect(model.error_code).toBe('WIDGET_ELEMENT_REPLACED');
      // The message must not send the model after an internal ref it never saw.
      expect(String(model.message)).not.toMatch(/\be\d+\b/);
      expect(String(model.message)).toContain('Dates');
      expect(String(model.message)).toMatch(/retry/i);
    });
  });

  it('is registered only in the do profile', () => {
    for (const name of ['browser_pick_date', 'browser_pick_option'] as const) {
      expect(COMMAND_TASK_PROFILES.do.toolNames).toContain(name);
      expect(COMMAND_TASK_PROFILES.ask.toolNames).not.toContain(name);
      expect(COMMAND_TASK_PROFILES.research.toolNames).not.toContain(name);
    }
  });
});

function servicesFor(controller: WidgetController) {
  const browser: BrowserToolDeps = {
    controller: controller as unknown as AgentBrowserController,
    ethics: allowingEthics(),
    secretResolver: null,
    secretHosts: () => Promise.resolve([]),
    captureThresholdBytes: 16_384,
  };
  return buildServices({ domain: { browser } });
}

async function runOption(controller: WidgetController, params: unknown) {
  const services = servicesFor(controller);
  return wrapTool(browserPickOptionSpec(services), services).execute(params, undefined);
}

async function runDate(controller: WidgetController, params: unknown) {
  const services = servicesFor(controller);
  return wrapTool(browserPickDateSpec(services), services).execute(params, undefined);
}

function calendarController(): WidgetController {
  const controller = new WidgetController(
    '<button id="trigger" aria-label="Dates" aria-controls="calendar" aria-expanded="true">Dates</button>' +
      '<div id="calendar" role="dialog"><table><caption>September 2026</caption><tbody><tr>' +
      '<td><button data-date="2026-09-06">6</button></td>' +
      '<td><button data-date="2026-09-08">8</button></td>' +
      '</tr></tbody></table></div>',
  );
  const selected: string[] = [];
  for (const button of controller.document.querySelectorAll<HTMLButtonElement>('table button')) {
    button.addEventListener('click', () => {
      selected.push(button.textContent?.trim() ?? '');
      const label = selected.map((day) => `Sep ${day}, 2026`).join(' - ');
      controller.document.querySelector('#trigger')!.setAttribute('aria-label', label);
    });
  }
  return controller;
}

/**
 * The naming Expedia actually ships: the trigger keeps its `"Dates, "` prefix
 * and only the value after it changes as days are picked. Every observation in
 * runs 20260808T015833Z, T030747Z, and T033702Z shows that shape.
 */
function expediaShapedCalendar(): WidgetController {
  const controller = new WidgetController(
    '<button id="trigger" aria-label="Dates, Fri, Aug 21 - Sat, Aug 22" aria-controls="calendar" ' +
      'aria-expanded="true">Dates</button>' +
      '<div id="calendar" role="dialog"><table><caption>September 2026</caption><tbody><tr>' +
      '<td><button data-date="2026-09-06">6</button></td>' +
      '<td><button data-date="2026-09-08">8</button></td>' +
      '</tr></tbody></table></div>',
  );
  const selected: string[] = [];
  for (const button of controller.document.querySelectorAll<HTMLButtonElement>('table button')) {
    button.addEventListener('click', () => {
      selected.push(button.textContent?.trim() ?? '');
      const value = selected.map((day) => `Sep ${day}, 2026`).join(' - ');
      controller.document.querySelector('#trigger')!.setAttribute('aria-label', `Dates, ${value}`);
    });
  }
  return controller;
}

class WidgetController {
  public readonly window: JSDOM['window'];
  public readonly document: Document;
  public actionCount = 0;
  public observationCount = 0;
  private readonly refsByElement = new Map<HTMLElement, string>();
  private readonly elementsByRef = new Map<string, HTMLElement>();
  private nextRef = 1;
  private pendingReplacement: {
    readonly selector: string;
    readonly mutate: ((element: HTMLElement) => void) | undefined;
  } | null = null;

  public constructor(html: string) {
    const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
      pretendToBeVisual: true,
    });
    this.window = dom.window;
    this.document = dom.window.document;
    this.refreshRefs();
  }

  public async observe(): Promise<AgentBrowserObservation> {
    this.observationCount += 1;
    this.refreshRefs();
    const interactables: AgentInteractable[] = [...this.elementsByRef].map(([ref, element]) => ({
      ref,
      role:
        element.getAttribute('role') ??
        (element instanceof this.window.HTMLInputElement ||
        element instanceof this.window.HTMLSelectElement
          ? 'combobox'
          : 'button'),
      name: element.getAttribute('aria-label') ?? element.textContent?.trim() ?? '',
      ...(this.valueOf(element) ? { value: this.valueOf(element)! } : {}),
      ...(element.closest('table')?.querySelector('caption')?.textContent
        ? { group: element.closest('table')!.querySelector('caption')!.textContent!.trim() }
        : {}),
    }));
    return {
      url: 'https://example.test/',
      title: 'Fixture',
      digest: 'fixture',
      digestUnchanged: false,
      interactables,
    };
  }

  public describeRef(ref: string): AgentInteractable | undefined {
    const element = this.elementsByRef.get(ref);
    if (!element) return undefined;
    return {
      ref,
      role: element.getAttribute('role') ?? 'button',
      name: element.getAttribute('aria-label') ?? element.textContent?.trim() ?? '',
    };
  }

  public locatorFor(): Promise<[]> {
    return Promise.resolve([]);
  }

  public host(): string {
    return 'example.test';
  }

  public async click(ref: string): Promise<Record<string, never>> {
    this.actionCount += 1;
    this.element(ref).click();
    this.applyPendingReplacement();
    return {};
  }

  public async fill(ref: string, value: string): Promise<Record<string, never>> {
    this.actionCount += 1;
    const element = this.element(ref);
    if (element instanceof this.window.HTMLSelectElement) {
      const option = [...element.options].find(
        (candidate) => candidate.value === value || candidate.label.trim() === value.trim(),
      );
      if (!option) throw new Error('option not found');
      element.value = option.value;
    } else if (element instanceof this.window.HTMLInputElement) {
      element.value = value;
    }
    return {};
  }

  public evaluateOn<T, Args extends readonly unknown[]>(
    ref: string,
    fn: (element: HTMLElement, ...args: Args) => T | Promise<T>,
    ...args: Args
  ): Promise<T> {
    return this.inDom(() => fn(this.element(ref), ...args));
  }

  public evaluate<T, Args extends readonly unknown[]>(
    fn: (...args: Args) => T | Promise<T>,
    ...args: Args
  ): Promise<T> {
    return this.inDom(() => fn(...args));
  }

  public async press(key: string): Promise<void> {
    this.document.dispatchEvent(new this.window.KeyboardEvent('keydown', { key, bubbles: true }));
  }

  public now(): number {
    return Date.now();
  }

  private refreshRefs(): void {
    this.elementsByRef.clear();
    for (const element of this.document.querySelectorAll<HTMLElement>(
      'button,input,select,[role="button"],[role="option"],[data-yantra-widget-target]',
    )) {
      let ref = this.refsByElement.get(element);
      if (!ref) {
        ref = `e${this.nextRef++}`;
        this.refsByElement.set(element, ref);
      }
      this.elementsByRef.set(ref, element);
    }
  }

  /**
   * Replace `selector`'s element on the next click anywhere, the way a
   * framework re-render swaps out a node the driver is still holding a ref to.
   */
  public replaceElementOnClick(selector: string, mutate?: (element: HTMLElement) => void): void {
    this.pendingReplacement = { selector, mutate };
  }

  private applyPendingReplacement(): void {
    const pending = this.pendingReplacement;
    if (!pending) return;
    this.pendingReplacement = null;
    const element = this.document.querySelector<HTMLElement>(pending.selector);
    if (!element) return;
    const replacement = element.cloneNode(true) as HTMLElement;
    pending.mutate?.(replacement);
    element.replaceWith(replacement);
    const staleRef = this.refsByElement.get(element);
    if (staleRef) this.elementsByRef.delete(staleRef);
    this.refsByElement.delete(element);
  }

  private element(ref: string): HTMLElement {
    const element = this.elementsByRef.get(ref);
    // The real controller raises a typed error carrying this code; the healing
    // port keys on it, so the fixture must not degrade it to a bare Error.
    if (!element)
      throw Object.assign(new Error(`unknown ref ${ref}`), { code: 'STALE_ELEMENT_REF' });
    return element;
  }

  private valueOf(element: HTMLElement): string | null {
    if (element instanceof this.window.HTMLInputElement) return element.value || null;
    if (element instanceof this.window.HTMLSelectElement) {
      const option = element.selectedOptions[0];
      return option ? option.label || option.text : null;
    }
    return null;
  }

  private async inDom<T>(body: () => T | Promise<T>): Promise<T> {
    const names = [
      'document',
      'window',
      'Element',
      'HTMLElement',
      'HTMLInputElement',
      'HTMLTextAreaElement',
      'HTMLSelectElement',
      'HTMLTableElement',
      'HTMLTableCellElement',
      'HTMLButtonElement',
    ] as const;
    const prior = new Map<string, PropertyDescriptor | undefined>();
    for (const name of names) {
      prior.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Object.defineProperty(globalThis, name, {
        configurable: true,
        writable: true,
        value: name === 'window' ? this.window : this.window[name],
      });
    }
    try {
      return await body();
    } finally {
      for (const name of names) {
        const descriptor = prior.get(name);
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    }
  }
}
