/// <reference lib="dom" />

import { globSync, readFileSync } from 'node:fs';

import {
  WidgetRegistry,
  type AgentBrowserController,
  type AgentBrowserObservation,
  type AgentInteractable,
} from '@yantra/core';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';

import { browserFormFillSpec } from '../../../../src/adapters/pi/tools/browser-form-fill.js';
import { wrapTool } from '../../../../src/runtime/middleware.js';
import type { BrowserToolDeps } from '../../../../src/runtime/run-services.js';

import { allowingEthics, buildServices } from './test-support.js';

describe('@no-llm browser_form_fill driver delegation', () => {
  it('applies text, typeahead, and a date range through the expected paths', async () => {
    const controller = formController();

    const result = await run(controller, {
      fields: [
        { field: 'Search', value: 'stadium hotels' },
        { field: 'Where to?', value: 'Frisco, Texas' },
        { field: 'Dates', value: '2026-09-06..2026-09-08' },
      ],
    });
    const model = JSON.parse(result.modelText) as {
      readonly applied: readonly Record<string, unknown>[];
    };

    expect(result.status).toBe('ok');
    expect(model.applied).toEqual([
      expect.objectContaining({
        field: 'Search',
        driver: 'plain-text',
        action: 'filled',
        committed: 'stadium hotels',
      }),
      expect.objectContaining({
        field: 'Where to?',
        driver: 'typeahead',
        action: 'picked_option',
        committed: 'Frisco Texas, United States',
      }),
      expect.objectContaining({
        field: 'Dates',
        driver: 'calendar-grid',
        action: 'picked_date',
        committed: 'Sep 6, 2026 - Sep 8, 2026',
      }),
    ]);
  });

  it('preserves field ordering and stops at the first failure', async () => {
    const controller = new FormController(
      '<input id="first" aria-label="First"><button id="toggle" aria-label="Toggle">Toggle</button>' +
        '<input id="last" aria-label="Last">',
    );

    const result = await run(controller, {
      fields: [
        { field: 'First', value: 'one' },
        { field: 'Toggle', value: 'two' },
        { field: 'Last', value: 'three' },
      ],
    });
    expect(result.error_code).toBe('FORM_FIELD_UNSUPPORTED_ROLE');
    expect(
      (result.details as { readonly applied: readonly Record<string, unknown>[] }).applied,
    ).toEqual([expect.objectContaining({ field: 'First', committed: 'one' })]);
    expect(controller.document.querySelector<HTMLInputElement>('#last')!.value).toBe('');
  });

  it('does not toggle an already-open calendar shut', async () => {
    const controller = formController();

    const result = await run(controller, {
      fields: [{ field: 'Dates', value: '2026-09-06' }],
    });

    expect(result.status).toBe('ok');
    expect(controller.clickLog).toEqual(['6']);
  });

  it('accepts deprecated pick_suggestion without changing automatic typeahead behavior', async () => {
    const withFlag = formController();
    const flagged = await run(withFlag, {
      fields: [{ field: 'Where to?', value: 'Frisco, Texas', pick_suggestion: true }],
    });
    const omitted = formController();
    const automatic = await run(omitted, {
      fields: [{ field: 'Where to?', value: 'Frisco, Texas' }],
    });

    expect(flagged.status).toBe('ok');
    expect(automatic.status).toBe('ok');
    expect(withFlag.document.querySelector<HTMLInputElement>('#destination')!.value).toBe(
      'Frisco Texas, United States',
    );
    expect(omitted.document.querySelector<HTMLInputElement>('#destination')!.value).toBe(
      'Frisco Texas, United States',
    );
  });

  it('keeps retired widget error codes and helpers out of agent source', () => {
    const sourceRoot = new URL('../../../../src/', import.meta.url);
    const source = globSync('**/*.ts', { cwd: sourceRoot })
      .map((file) => readFileSync(new URL(file.replaceAll('\\', '/'), sourceRoot), 'utf8'))
      .join('\n');

    expect(source).not.toMatch(/FORM_WIDGET_NO_MATCH|SUGGESTION_NOT_OFFERED/);
    expect(source).not.toMatch(/\bchooseInWidget\b|\bpickSuggestion\b/);
  });

  it('fills plain text without invoking registry drive', async () => {
    const controller = new FormController('<input id="search" aria-label="Search">');
    const drive = vi.spyOn(WidgetRegistry.prototype, 'driveWidget');

    const result = await run(controller, {
      fields: [{ field: 'Search', value: 'hello' }],
    });

    expect(result.status).toBe('ok');
    expect(drive).not.toHaveBeenCalled();
    expect(controller.clickLog).toEqual([]);
    drive.mockRestore();
  });

  it('refuses a credential-shaped value before partially filling the form', async () => {
    const controller = new FormController(
      '<input id="first" aria-label="First"><input id="second" aria-label="Second">',
    );

    const result = await run(controller, {
      fields: [
        { field: 'First', value: 'safe' },
        { field: 'Second', value: 'sk-abcdefghijklmnopqrstuvwxyz' },
      ],
    });

    expect(result.error_code).toBe('SECRET_SHAPED_LITERAL');
    expect(controller.observationCount).toBe(0);
    expect(controller.document.querySelector<HTMLInputElement>('#first')!.value).toBe('');
  });
});

async function run(controller: FormController, params: unknown) {
  const browser: BrowserToolDeps = {
    controller: controller as unknown as AgentBrowserController,
    ethics: allowingEthics(),
    secretResolver: null,
    secretHosts: () => Promise.resolve([]),
    captureThresholdBytes: 16_384,
  };
  const services = buildServices({ domain: { browser } });
  return wrapTool(browserFormFillSpec(services), services).execute(params, undefined);
}

function formController(): FormController {
  const controller = new FormController(
    '<input id="search" aria-label="Search">' +
      '<input id="destination" role="combobox" aria-label="Where to?" aria-autocomplete="list" aria-controls="suggestions" aria-expanded="false">' +
      '<div id="suggestions" role="listbox" style="display:none"><button>Frisco Texas, United States</button><button>Toyota Stadium Frisco, Texas, United States</button></div>' +
      '<button id="dates" aria-label="Dates" aria-controls="calendar" aria-expanded="true">Dates</button>' +
      '<div id="calendar" role="dialog"><table><caption>September 2026</caption><tbody><tr>' +
      '<td><button data-date="2026-09-06">6</button></td><td><button data-date="2026-09-08">8</button></td>' +
      '</tr></tbody></table></div>',
  );
  const destination = controller.document.querySelector<HTMLInputElement>('#destination')!;
  const suggestions = controller.document.querySelector<HTMLElement>('#suggestions')!;
  destination.addEventListener('input', () => {
    destination.setAttribute('aria-expanded', 'true');
    suggestions.style.display = 'block';
  });
  for (const choice of suggestions.querySelectorAll<HTMLButtonElement>('button')) {
    choice.addEventListener('click', () => {
      destination.value = choice.textContent?.trim() ?? '';
      destination.setAttribute('aria-expanded', 'false');
      suggestions.style.display = 'none';
    });
  }
  const dates = controller.document.querySelector<HTMLElement>('#dates')!;
  const selected: string[] = [];
  for (const day of controller.document.querySelectorAll<HTMLButtonElement>('#calendar button')) {
    day.addEventListener('click', () => {
      selected.push(day.textContent?.trim() ?? '');
      dates.setAttribute(
        'aria-label',
        selected
          .slice(-2)
          .map((value) => `Sep ${value}, 2026`)
          .join(' - '),
      );
    });
  }
  return controller;
}

class FormController {
  public readonly window: JSDOM['window'];
  public readonly document: Document;
  public readonly clickLog: string[] = [];
  public observationCount = 0;
  private readonly refsByElement = new Map<HTMLElement, string>();
  private readonly elementsByRef = new Map<string, HTMLElement>();
  private nextRef = 1;

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
        (element instanceof this.window.HTMLInputElement ? 'textbox' : 'button'),
      name: element.getAttribute('aria-label') ?? element.textContent?.trim() ?? '',
      ...(this.valueOf(element) ? { value: this.valueOf(element)! } : {}),
      ...(element.closest('table')?.querySelector('caption')?.textContent
        ? { group: element.closest('table')!.querySelector('caption')!.textContent!.trim() }
        : {}),
    }));
    return {
      url: 'https://example.test/',
      title: 'Form',
      digest: 'form',
      digestUnchanged: false,
      interactables,
    };
  }

  public describeRef(ref: string): AgentInteractable | undefined {
    const element = this.elementsByRef.get(ref);
    return element
      ? {
          ref,
          role: element.getAttribute('role') ?? 'button',
          name: element.getAttribute('aria-label') ?? element.textContent?.trim() ?? '',
        }
      : undefined;
  }

  public locatorFor(): Promise<[]> {
    return Promise.resolve([]);
  }

  public host(): string {
    return 'example.test';
  }

  public async click(ref: string): Promise<Record<string, never>> {
    const element = this.element(ref);
    this.clickLog.push(element.getAttribute('aria-label') ?? element.textContent?.trim() ?? '');
    element.click();
    return {};
  }

  public async fill(ref: string, value: string): Promise<Record<string, never>> {
    const element = this.element(ref);
    if (!(element instanceof this.window.HTMLInputElement)) throw new Error('not an input');
    element.value = value;
    element.dispatchEvent(new this.window.Event('input', { bubbles: true }));
    element.dispatchEvent(new this.window.Event('change', { bubbles: true }));
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

  private element(ref: string): HTMLElement {
    const element = this.elementsByRef.get(ref);
    if (!element) throw new Error(`unknown ref ${ref}`);
    return element;
  }

  private valueOf(element: HTMLElement): string | null {
    return element instanceof this.window.HTMLInputElement && element.value ? element.value : null;
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
