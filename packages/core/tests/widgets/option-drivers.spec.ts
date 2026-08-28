import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  listboxDriver,
  nativeSelectDriver,
  watchAndSelect,
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

  // There is now exactly one typeahead implementation — `watchAndSelect`, the
  // fill engine's post-typing step. The dedicated `typeaheadDriver` that used
  // to sit beside it in the widget registry was never reachable from
  // production code and had already drifted from this one, so it is gone.
  it.each([['button'] as const, ['option'] as const])(
    'commits a %s-shaped suggestion, without requiring role=option',
    async (role) => {
      const port = typeaheadFixture(role);

      const outcome = await watchAndSelect(port, target('Where to?'), 'Frisco, Texas', BUDGET);

      expect(outcome).toMatchObject({
        ok: true,
        selected: true,
        committed: 'Frisco Texas, United States',
        chosen: 'Frisco Texas, United States',
      });
      expect(port.clickedNames()).toEqual(['Frisco Texas, United States']);
    },
  );

  it('reports not committed when the suggestion click leaves the field empty', async () => {
    const port = new DomOptionPort(
      '<input id="trigger" role="combobox" aria-autocomplete="list" aria-controls="suggestions" aria-expanded="true">' +
        '<div id="suggestions" role="listbox"><button>Frisco Texas</button><button>Plano Texas</button></div>',
    );

    const outcome = await watchAndSelect(port, target('Where to?'), 'Frisco Texas', BUDGET);

    expect(outcome).toMatchObject({ ok: false, errorCode: 'WIDGET_NOT_COMMITTED' });
  });

  it('leaves the typed text standing when an open popup offers nothing', async () => {
    const port = new DomOptionPort(
      '<input id="trigger" role="combobox" aria-autocomplete="list" aria-controls="suggestions" aria-expanded="true">' +
        '<div id="suggestions" role="listbox"></div>',
    );
    port.setInputValue('Nowhere');

    const outcome = await watchAndSelect(port, target('Where to?'), 'Nowhere', {
      ...BUDGET,
      deadlineMs: Date.now() + 600,
    });

    expect(outcome).toMatchObject({ ok: true, selected: false, committed: 'Nowhere' });
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

  public async clear(ref: string): Promise<void> {
    const element = this.element(ref);
    if (element instanceof this.window.HTMLInputElement) {
      element.value = '';
      element.dispatchEvent(new this.window.Event('input', { bubbles: true }));
    }
  }

  public async type(ref: string, text: string): Promise<void> {
    const element = this.element(ref);
    if (element instanceof this.window.HTMLInputElement) {
      for (const character of text) {
        element.value += character;
        element.dispatchEvent(new this.window.Event('input', { bubbles: true }));
      }
    }
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
