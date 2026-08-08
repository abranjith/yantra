import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

import {
  OPEN_WAIT_MS,
  openIfClosed,
  restore,
  withTag,
  type AgentBrowserObservation,
  type WidgetPort,
  type WidgetTarget,
} from '../../src/index.js';

const TARGET: WidgetTarget = {
  ref: 'e1',
  role: 'button',
  name: 'Dates',
  group: null,
  value: null,
};

describe('@no-llm widget open state', () => {
  it('does not click an already-open widget and reports the entry state', async () => {
    const port = new DomPort(
      '<button id="trigger" aria-controls="popup" aria-expanded="true">Dates</button>' +
        '<div id="popup" role="dialog"><button>6</button></div>',
    );

    const result = await openIfClosed(port, TARGET);

    expect(result).toMatchObject({ ok: true, wasOpen: true });
    expect(port.clicks).toBe(0);
  });

  it('opens a closed widget once and restores it with Escape', async () => {
    const port = new DomPort(
      '<button id="trigger" aria-controls="popup" aria-expanded="false">Dates</button>' +
        '<div id="popup" role="dialog" style="display:none"><button>6</button></div>',
    );
    const trigger = port.document.querySelector('#trigger')!;
    const popup = port.document.querySelector<HTMLElement>('#popup')!;
    trigger.addEventListener('click', () => {
      const opening = trigger.getAttribute('aria-expanded') !== 'true';
      trigger.setAttribute('aria-expanded', opening ? 'true' : 'false');
      popup.style.display = opening ? 'block' : 'none';
    });
    port.document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        trigger.setAttribute('aria-expanded', 'false');
        popup.style.display = 'none';
      }
    });

    const opened = await openIfClosed(port, TARGET);
    expect(opened).toMatchObject({ ok: true, wasOpen: false });
    expect(port.clicks).toBe(1);
    if (!opened.ok) throw new Error('fixture did not open');

    await restore(port, TARGET, opened.wasOpen);

    expect(port.presses).toEqual(['Escape']);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(port.clicks).toBe(1);
  });

  it('leaves a widget that was already open alone during restore', async () => {
    const port = new DomPort(
      '<button id="trigger" aria-controls="popup" aria-expanded="true">Dates</button>' +
        '<div id="popup" role="dialog"><button>6</button></div>',
    );

    await restore(port, TARGET, true);

    expect(port.presses).toEqual([]);
    expect(port.clicks).toBe(0);
  });

  it('returns a bounded typed failure when a closed widget never opens', async () => {
    let clock = 0;
    const port = new DomPort('<button id="trigger" aria-expanded="false">Dates</button>', () => {
      clock += OPEN_WAIT_MS;
      return clock;
    });

    const result = await openIfClosed(port, TARGET);

    expect(result).toMatchObject({ ok: false, errorCode: 'WIDGET_DID_NOT_OPEN' });
    expect(port.clicks).toBe(1);
  });

  it('removes a temporary tag on success and when the body throws', async () => {
    const port = new DomPort('<button id="trigger">Dates</button><button id="choice">6</button>');
    const selector = (attribute: string, token: string): boolean => {
      const choice = document.querySelector('#choice');
      if (!choice) return false;
      choice.setAttribute(attribute, token);
      return true;
    };

    await expect(withTag(port, selector, async (ref) => ref)).resolves.toBe('e2');
    expect(port.document.querySelector('[data-yantra-widget-target]')).toBeNull();

    await expect(
      withTag(port, selector, async () => {
        throw new Error('body failed');
      }),
    ).rejects.toThrow('body failed');
    expect(port.document.querySelector('[data-yantra-widget-target]')).toBeNull();
  });
});

class DomPort implements WidgetPort {
  public readonly document: Document;
  public clicks = 0;
  public readonly presses: string[] = [];
  private readonly window: JSDOM['window'];
  private readonly clock: () => number;
  private readonly refs = new Map<string, HTMLElement>();

  public constructor(html: string, clock: () => number = () => Date.now()) {
    const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`);
    this.window = dom.window;
    this.document = dom.window.document;
    this.clock = clock;
    this.refreshRefs();
  }

  public async observe(): Promise<AgentBrowserObservation> {
    this.refreshRefs();
    return {
      url: 'https://example.test/',
      title: '',
      digest: '',
      digestUnchanged: false,
      interactables: [...this.refs].map(([ref, element]) => ({
        ref,
        role: element.getAttribute('role') ?? (element.tagName === 'BUTTON' ? 'button' : 'textbox'),
        name: element.getAttribute('aria-label') ?? element.textContent?.trim() ?? '',
      })),
    };
  }

  public async click(ref: string): Promise<void> {
    this.clicks += 1;
    this.element(ref).click();
  }

  public async fill(ref: string, value: string): Promise<void> {
    const element = this.element(ref);
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
    this.presses.push(key);
    this.document.dispatchEvent(new this.window.KeyboardEvent('keydown', { key, bubbles: true }));
  }

  public now(): number {
    return this.clock();
  }

  private element(ref: string): HTMLElement {
    const element = this.refs.get(ref);
    if (!element) throw new Error(`unknown ref ${ref}`);
    return element;
  }

  private refreshRefs(): void {
    const candidates = this.document.querySelectorAll<HTMLElement>(
      'button,input,select,textarea,[role="button"],[role="option"],[role="menuitem"]',
    );
    candidates.forEach((element, index) => this.refs.set(`e${index + 1}`, element));
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
