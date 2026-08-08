import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  listboxDriver,
  nativeSelectDriver,
  typeaheadDriver,
  type AgentBrowserObservation,
  type WidgetBudget,
  type WidgetPort,
  type WidgetTarget,
} from '../../src/index.js';

const BUDGET: WidgetBudget = {
  deadlineMs: Number.MAX_SAFE_INTEGER,
  maxPagingSteps: 12,
  maxActions: 24,
};

describe('@no-llm option widget drivers', () => {
  afterEach(() => vi.useRealTimers());

  it('picks an Expedia-shaped button suggestion without requiring role=option', async () => {
    const port = typeaheadFixture('button');

    const outcome = await typeaheadDriver.drive(
      port,
      target('Where to?'),
      { kind: 'option', value: 'Frisco, Texas' },
      BUDGET,
    );

    expect(outcome).toMatchObject({
      ok: true,
      driver: 'typeahead',
      committed: 'Frisco Texas, United States',
    });
    expect(port.clickedNames()).toEqual(['Frisco Texas, United States']);
  });

  it('continues to support role=option suggestions', async () => {
    const port = typeaheadFixture('option');

    const outcome = await typeaheadDriver.drive(
      port,
      target('Where to?'),
      { kind: 'option', value: 'Frisco, Texas' },
      BUDGET,
    );

    expect(outcome.ok).toBe(true);
    expect(port.clickedNames()).toEqual(['Frisco Texas, United States']);
  });

  it('selects a native option by visible label and by value', async () => {
    const byLabel = new DomOptionPort(
      '<select id="trigger"><option value="dfw">Dallas</option><option value="fr">Frisco</option></select>',
    );
    const labelOutcome = await nativeSelectDriver.drive(
      byLabel,
      target('City'),
      { kind: 'option', value: 'Frisco' },
      BUDGET,
    );
    expect(labelOutcome).toMatchObject({ ok: true, committed: 'Frisco' });

    const byValue = new DomOptionPort(
      '<select id="trigger"><option value="dfw">Dallas</option><option value="fr">Frisco</option></select>',
    );
    const valueOutcome = await nativeSelectDriver.drive(
      byValue,
      target('City'),
      { kind: 'option', value: 'fr' },
      BUDGET,
    );
    expect(valueOutcome).toMatchObject({ ok: true, committed: 'Frisco' });
  });

  it('polls until a suggestion arriving after 1.2 seconds can be picked', async () => {
    vi.useFakeTimers();
    const port = new DomOptionPort(
      '<input id="trigger" role="combobox" aria-autocomplete="list" aria-controls="suggestions" aria-expanded="false">' +
        '<div id="suggestions" role="listbox" style="display:none"></div>',
      (instance, _ref, value) => {
        instance.window.setTimeout(() => {
          const popup = instance.document.querySelector<HTMLElement>('#suggestions')!;
          popup.style.display = 'block';
          instance.document.querySelector('#trigger')!.setAttribute('aria-expanded', 'true');
          popup.innerHTML =
            '<button>Frisco Texas, United States</button><button>Plano Texas</button>';
          instance.installCommitHandlers();
        }, 1_200);
        instance.setInputValue(value);
      },
    );

    const pending = typeaheadDriver.drive(
      port,
      target('Where to?'),
      { kind: 'option', value: 'Frisco, Texas' },
      { ...BUDGET, deadlineMs: Date.now() + 10_000 },
    );
    await vi.advanceTimersByTimeAsync(1_500);

    await expect(pending).resolves.toMatchObject({ ok: true, driver: 'typeahead' });
  });

  it('returns a bounded unreachable failure when no candidate appears', async () => {
    let now = 0;
    const port = new DomOptionPort(
      '<input id="trigger" role="combobox" aria-autocomplete="list" aria-controls="suggestions" aria-expanded="true">' +
        '<div id="suggestions" role="listbox"></div>',
      undefined,
      () => {
        now += 1_000;
        return now;
      },
    );

    const outcome = await typeaheadDriver.drive(
      port,
      target('Where to?'),
      { kind: 'option', value: 'Nowhere' },
      { ...BUDGET, deadlineMs: 20_000 },
    );

    expect(outcome).toMatchObject({
      ok: false,
      errorCode: 'WIDGET_TARGET_UNREACHABLE',
      details: { waitMs: 3_000 },
    });
  });

  it('returns ambiguity with offered names and dispatches no choice click', async () => {
    const port = new DomOptionPort(
      '<button id="trigger" aria-controls="choices" aria-expanded="true">City</button>' +
        '<div id="choices" role="listbox"><button>Frisco</button><button>Frisco</button></div>',
    );

    const outcome = await listboxDriver.drive(
      port,
      target('City'),
      { kind: 'option', value: 'Frisco' },
      BUDGET,
    );

    expect(outcome).toMatchObject({
      ok: false,
      errorCode: 'WIDGET_AMBIGUOUS_CHOICE',
      details: { offered: ['Frisco', 'Frisco'] },
    });
    expect(port.clickedNames()).toEqual([]);
  });

  it('reports not committed when a suggestion click leaves the raw text unchanged', async () => {
    const port = new DomOptionPort(
      '<input id="trigger" role="combobox" aria-autocomplete="list" aria-controls="suggestions" aria-expanded="true">' +
        '<div id="suggestions" role="listbox"><button>Frisco Texas</button><button>Plano Texas</button></div>',
    );

    const outcome = await typeaheadDriver.drive(
      port,
      target('Where to?'),
      { kind: 'option', value: 'Frisco Texas' },
      BUDGET,
    );

    expect(outcome).toMatchObject({ ok: false, errorCode: 'WIDGET_NOT_COMMITTED' });
  });

  it('does not dispatch an opening click for an already-open listbox', async () => {
    const port = new DomOptionPort(
      '<button id="trigger" aria-controls="choices" aria-expanded="true">City</button>' +
        '<div id="choices" role="listbox"><button>Frisco</button><button>Plano</button></div>',
    );
    port.installCommitHandlers();

    const outcome = await listboxDriver.drive(
      port,
      target('City'),
      { kind: 'option', value: 'Frisco' },
      BUDGET,
    );

    expect(outcome.ok).toBe(true);
    expect(port.clickedNames()).toEqual(['Frisco']);
  });
});

function target(name: string): WidgetTarget {
  return { ref: 'e1', role: 'combobox', name, group: null, value: null };
}

function typeaheadFixture(role: 'button' | 'option'): DomOptionPort {
  const child =
    role === 'button'
      ? '<button>Frisco Texas, United States</button><button>Toyota Stadium Frisco, Texas, United States</button>'
      : '<div role="option">Frisco Texas, United States</div><div role="option">Toyota Stadium Frisco, Texas, United States</div>';
  const port = new DomOptionPort(
    '<input id="trigger" role="combobox" aria-autocomplete="list" aria-controls="suggestions" aria-expanded="true">' +
      `<div id="suggestions" role="listbox">${child}</div>`,
  );
  port.installCommitHandlers();
  return port;
}

type FillHook = (port: DomOptionPort, ref: string, value: string) => void;

class DomOptionPort implements WidgetPort {
  public readonly window: JSDOM['window'];
  public readonly document: Document;
  private readonly fillHook: FillHook | undefined;
  private readonly clock: () => number;
  private readonly refsByElement = new Map<HTMLElement, string>();
  private readonly elementsByRef = new Map<string, HTMLElement>();
  private readonly clickLog: string[] = [];
  private nextRef = 1;

  public constructor(html: string, fillHook?: FillHook, clock: () => number = () => Date.now()) {
    const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
      pretendToBeVisual: true,
    });
    this.window = dom.window;
    this.document = dom.window.document;
    this.fillHook = fillHook;
    this.clock = clock;
    this.refreshRefs();
  }

  public installCommitHandlers(): void {
    const trigger = this.document.querySelector<HTMLInputElement | HTMLButtonElement>('#trigger')!;
    const choices = this.document.querySelectorAll<HTMLElement>(
      '#suggestions button,#suggestions [role="option"],#choices button,#choices [role="option"]',
    );
    for (const choice of choices) {
      choice.addEventListener('click', () => {
        if (trigger instanceof this.window.HTMLInputElement)
          trigger.value = choice.textContent?.trim() ?? '';
        else trigger.setAttribute('aria-label', choice.textContent?.trim() ?? '');
        trigger.setAttribute('aria-expanded', 'false');
      });
    }
  }

  public setInputValue(value: string): void {
    const trigger = this.document.querySelector<HTMLInputElement>('#trigger');
    if (trigger) trigger.value = value;
  }

  public clickedNames(): readonly string[] {
    return this.clickLog;
  }

  public async observe(): Promise<AgentBrowserObservation> {
    this.refreshRefs();
    return {
      url: 'https://example.test/',
      title: '',
      digest: '',
      digestUnchanged: false,
      interactables: [...this.elementsByRef].map(([ref, element]) => ({
        ref,
        role: this.role(element),
        name: element.getAttribute('aria-label') ?? element.textContent?.trim() ?? '',
        ...(element instanceof this.window.HTMLInputElement && element.value
          ? { value: element.value }
          : {}),
      })),
    };
  }

  public async click(ref: string): Promise<void> {
    const element = this.element(ref);
    if (element.id !== 'trigger') this.clickLog.push(element.textContent?.trim() ?? '');
    element.click();
  }

  public async fill(ref: string, value: string): Promise<void> {
    if (this.fillHook) {
      this.fillHook(this, ref, value);
      return;
    }
    const element = this.element(ref);
    if (element instanceof this.window.HTMLSelectElement) {
      const option = [...element.options].find(
        (candidate) => candidate.value === value || candidate.label.trim() === value.trim(),
      );
      if (!option) throw new Error('option not found');
      element.value = option.value;
      element.dispatchEvent(new this.window.Event('input', { bubbles: true }));
      element.dispatchEvent(new this.window.Event('change', { bubbles: true }));
      return;
    }
    if (element instanceof this.window.HTMLInputElement) element.value = value;
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
    return this.clock();
  }

  private refreshRefs(): void {
    const candidates = this.document.querySelectorAll<HTMLElement>(
      'button,a[href],input,select,textarea,[role="button"],[role="combobox"],[role="menuitem"],[role="option"],[data-yantra-widget-target]',
    );
    for (const element of candidates) {
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

  private role(element: HTMLElement): string {
    return (
      element.getAttribute('role') ??
      (element instanceof this.window.HTMLSelectElement
        ? 'combobox'
        : element instanceof this.window.HTMLInputElement
          ? 'textbox'
          : 'button')
    );
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
