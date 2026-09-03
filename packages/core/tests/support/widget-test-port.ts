import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { JSDOM } from 'jsdom';

import type {
  AgentBrowserObservation,
  AgentInteractable,
  ScrollFrame,
  WidgetContainer,
  WidgetPort,
} from '../../src/index.js';
import { scrollContainerInPage } from '../../src/widgets/scroll.js';

/**
 * Small jsdom-backed {@link WidgetPort} for deterministic widget tests.
 *
 * Shared by the calendar suites and the behaviour-fixture regressions, so a
 * fixture exercised end to end runs through exactly the port shape the drivers
 * see everywhere else.
 */
export class WidgetTestPort implements WidgetPort {
  public readonly window: JSDOM['window'];
  public readonly document: Document;
  public readonly clickLog: { readonly name: string; readonly group: string | null }[] = [];
  private readonly clock: () => number;
  private readonly refsByElement = new Map<HTMLElement, string>();
  private readonly elementsByRef = new Map<string, HTMLElement>();
  private nextRef = 1;
  private readSignals = 0;

  /**
   * Load one behaviour fixture from `tests/fixtures/widgets` by file name.
   *
   * Fixture scripts are executed, because the behaviours being reproduced —
   * a swallowed keystroke, a list that arrives late, a picker that pages
   * months — are behaviours, not markup.
   */
  public static fromFixture(name: string, clock?: () => number): WidgetTestPort {
    const here = dirname(fileURLToPath(import.meta.url));
    const html = readFileSync(join(here, '..', 'fixtures', 'widgets', name), 'utf8');
    return new WidgetTestPort(html, clock, { runScripts: true });
  }

  public constructor(
    html: string,
    clock: () => number = () => Date.now(),
    options: { readonly runScripts?: boolean } = {},
  ) {
    const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
      pretendToBeVisual: true,
      ...(options.runScripts ? { runScripts: 'dangerously' as const } : {}),
    });
    this.window = dom.window;
    this.document = dom.window.document;
    this.clock = clock;
    this.refreshRefs();
  }

  public async observe(): Promise<AgentBrowserObservation> {
    this.signalRead();
    this.refreshRefs();
    const interactables: AgentInteractable[] = [...this.elementsByRef].map(([ref, element]) => {
      const value =
        element instanceof this.window.HTMLInputElement && element.value.length > 0
          ? element.value
          : undefined;
      return {
        ref,
        role:
          element.getAttribute('role') ??
          (element instanceof this.window.HTMLInputElement ? 'textbox' : 'button'),
        name: element.getAttribute('aria-label') ?? element.textContent?.trim() ?? '',
        ...(value ? { value } : {}),
        ...(this.groupOf(element) ? { group: this.groupOf(element)! } : {}),
        ...(element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true'
          ? { disabled: true as const }
          : {}),
      };
    });
    return {
      url: 'https://example.test/',
      title: '',
      digest: '',
      digestUnchanged: false,
      interactables,
    };
  }

  public async click(ref: string): Promise<void> {
    const element = this.element(ref);
    this.clickLog.push({
      name: element.getAttribute('aria-label') ?? element.textContent?.trim() ?? '',
      group: this.groupOf(element),
    });
    element.click();
  }

  public async clear(ref: string): Promise<void> {
    const element = this.element(ref);
    if (
      element instanceof this.window.HTMLInputElement ||
      element instanceof this.window.HTMLTextAreaElement
    ) {
      element.value = '';
      element.dispatchEvent(new this.window.Event('input', { bubbles: true }));
    }
  }

  public async type(ref: string, text: string): Promise<void> {
    const element = this.element(ref);
    if (
      element instanceof this.window.HTMLInputElement ||
      element instanceof this.window.HTMLTextAreaElement
    ) {
      for (const character of text) {
        element.value += character;
        element.dispatchEvent(new this.window.Event('input', { bubbles: true }));
      }
    }
  }

  public async fill(ref: string, value: string): Promise<void> {
    const element = this.element(ref);
    if (
      !(element instanceof this.window.HTMLInputElement) &&
      !(element instanceof this.window.HTMLTextAreaElement) &&
      !(element instanceof this.window.HTMLSelectElement)
    ) {
      throw new Error('not a fillable control');
    }
    if (element instanceof this.window.HTMLSelectElement) {
      const option = Array.from(element.options).find(
        (candidate) => candidate.value === value || candidate.text.trim() === value.trim(),
      );
      if (!option) throw new Error(`missing option ${value}`);
      element.value = option.value;
    } else {
      element.value = value;
    }
    element.dispatchEvent(new this.window.Event('input', { bubbles: true }));
    element.dispatchEvent(new this.window.Event('change', { bubbles: true }));
  }

  public evaluateOn<T, Args extends readonly unknown[]>(
    ref: string,
    fn: (element: HTMLElement, ...args: Args) => T | Promise<T>,
    ...args: Args
  ): Promise<T> {
    this.signalRead();
    return this.inDom(() => fn(this.element(ref), ...args));
  }

  public evaluate<T, Args extends readonly unknown[]>(
    fn: (...args: Args) => T | Promise<T>,
    ...args: Args
  ): Promise<T> {
    this.signalRead();
    return this.inDom(() => fn(...args));
  }

  /**
   * Advance a container's own scrollable region, through the one shared
   * in-page implementation the real ports use.
   *
   * A mutation, so it takes no read signal. jsdom has no layout engine, so the
   * region reports `scrollHeight`/`clientHeight` of `0` and the default step
   * resolves to one unit — which is why termination is identity-first and a
   * fixture re-mounts from `scrollTop` rather than from geometry.
   */
  public scrollContainer(container: WidgetContainer, step?: number): Promise<ScrollFrame | null> {
    return this.inDom(() => scrollContainerInPage(container.path, step ?? null));
  }

  public async press(key: string): Promise<void> {
    this.document.dispatchEvent(new this.window.KeyboardEvent('keydown', { key, bubbles: true }));
  }

  public now(): number {
    return this.clock();
  }

  public refFor(selector: string): string {
    this.refreshRefs();
    const element = this.document.querySelector<HTMLElement>(selector);
    if (!element) throw new Error(`missing ${selector}`);
    return this.refsByElement.get(element)!;
  }

  private refreshRefs(): void {
    this.elementsByRef.clear();
    const candidates = this.document.querySelectorAll<HTMLElement>(
      'button,a[href],input,select,textarea,[role="button"],[role="combobox"],[role="menuitem"],[role="option"],[role="gridcell"],[data-yantra-widget-target]',
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
    // Match the real controller: a ref whose node has left the document is a
    // typed stale-ref failure, which is what triggers re-acquisition. Without
    // the code the engine's healing path cannot be exercised at all.
    if (!element || !this.document.contains(element)) {
      const error: Error & { code?: string } = new Error(`Element ref "${ref}" is stale.`);
      error.code = 'STALE_ELEMENT_REF';
      throw error;
    }
    return element;
  }

  private groupOf(element: HTMLElement): string | null {
    const table = element.closest('table');
    return table?.querySelector('caption')?.textContent?.trim() ?? null;
  }

  private signalRead(): void {
    this.readSignals += 1;
    this.document.dispatchEvent(
      new this.window.CustomEvent('yantra-test-read', { detail: this.readSignals }),
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
      'HTMLTableElement',
      'HTMLTableCellElement',
      'HTMLButtonElement',
      'Event',
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

/** Build a structurally valid month grid with bare-number day buttons. */
export function monthTable(
  year: number,
  month: number,
  options: { readonly mondayFirst?: boolean; readonly shift?: number } = {},
): string {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const mondayFirst = options.mondayFirst ?? false;
  const offset = (first + (mondayFirst ? 6 : 0)) % 7;
  const shifted = offset + (options.shift ?? 0);
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const weekdayNames = mondayFirst
    ? ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
    : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const slots = [
    ...Array.from({ length: shifted }, () => ''),
    ...Array.from({ length: days }, (_, index) => String(index + 1)),
  ];
  while (slots.length % 7 !== 0) slots.push('');
  const rows: string[] = [];
  for (let index = 0; index < slots.length; index += 7) {
    rows.push(
      `<tr>${slots
        .slice(index, index + 7)
        .map((day) => (day ? `<td><button>${day}</button></td>` : '<td></td>'))
        .join('')}</tr>`,
    );
  }
  const label = new Intl.DateTimeFormat('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, 1)));
  return (
    `<table><caption>${label}</caption><thead><tr>` +
    `${weekdayNames.map((day) => `<th>${day}</th>`).join('')}</tr></thead>` +
    `<tbody>${rows.join('')}</tbody></table>`
  );
}

/** Wire bare-number calendar buttons to update the trigger's committed label. */
export function installDateCommit(port: CalendarTestPort): void {
  const trigger = port.document.querySelector<HTMLElement>('#trigger')!;
  const selected: string[] = [];
  for (const button of port.document.querySelectorAll<HTMLButtonElement>('table button')) {
    button.addEventListener('click', () => {
      const caption = button.closest('table')?.querySelector('caption')?.textContent ?? '';
      const [monthName, yearText] = caption.trim().split(/\s+/);
      const rendered = `${monthName} ${button.textContent?.trim()}, ${yearText}`;
      selected.push(rendered);
      trigger.setAttribute('aria-label', selected.slice(-2).join(' - '));
    });
  }
}
