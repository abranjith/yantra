import { JSDOM } from 'jsdom';

import type { AgentBrowserObservation, AgentInteractable, WidgetPort } from '../../src/index.js';

/** Small jsdom-backed WidgetPort used by deterministic calendar-driver tests. */
export class CalendarTestPort implements WidgetPort {
  public readonly window: JSDOM['window'];
  public readonly document: Document;
  public readonly clickLog: { readonly name: string; readonly group: string | null }[] = [];
  private readonly clock: () => number;
  private readonly refsByElement = new Map<HTMLElement, string>();
  private readonly elementsByRef = new Map<string, HTMLElement>();
  private nextRef = 1;

  public constructor(html: string, clock: () => number = () => Date.now()) {
    const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
      pretendToBeVisual: true,
    });
    this.window = dom.window;
    this.document = dom.window.document;
    this.clock = clock;
    this.refreshRefs();
  }

  public async observe(): Promise<AgentBrowserObservation> {
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

  public async fill(ref: string, value: string): Promise<void> {
    const element = this.element(ref);
    if (!(element instanceof this.window.HTMLInputElement)) throw new Error('not an input');
    element.value = value;
    element.dispatchEvent(new this.window.Event('input', { bubbles: true }));
    element.dispatchEvent(new this.window.Event('change', { bubbles: true }));
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
    if (!element) throw new Error(`unknown ref ${ref}`);
    return element;
  }

  private groupOf(element: HTMLElement): string | null {
    const table = element.closest('table');
    return table?.querySelector('caption')?.textContent?.trim() ?? null;
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
