/// <reference lib="dom" />

/** One candidate element's raw signal, before ranking/capping. */
export interface RawInteractable {
  readonly role: string;
  readonly name: string | null;
  readonly kind: 'button' | 'link' | 'input' | 'select';
  readonly disabled: boolean;
  readonly top: number;
  readonly left: number;
  readonly group: string | null;
  readonly scope: 'dialog' | 'page';
  readonly value: string | null;
  readonly valuePresent: boolean;
  readonly checked: boolean | null;
  readonly expanded: boolean | null;
  readonly selected: boolean | null;
  readonly visible: boolean;
  /** Position in the scanner's candidate NodeList; never model-visible. */
  readonly selectorIndex?: number;
}

/**
 * Scans buttons, links, and form controls in page context. Accessible names
 * come primarily from the injected locator engine; the local computation is a
 * deliberately smaller offline fallback for pages where injection is absent.
 * The complete implementation is nested in this function because Puppeteer
 * serializes only the function body when it is passed to `Page.evaluate`.
 */
export function scanInteractablesInPage(): RawInteractable[] {
  const kindByRole: Record<string, 'button' | 'link' | 'input' | 'select'> = {
    button: 'button',
    link: 'link',
    textbox: 'input',
    searchbox: 'input',
    checkbox: 'input',
    radio: 'input',
    combobox: 'select',
    listbox: 'select',
    // Autocomplete suggestions. Without this the real options of a destination
    // or date combobox were structurally invisible to every observation, so an
    // agent that filled such a field had nothing correct left to click — the
    // logged run clicked a marketing tile instead. Options exist only while a
    // dropdown is open, so scanning them adds no steady-state noise.
    option: 'select',
  };
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>(
      'button, a[href], input, select, textarea, [role="button"], [role="link"], ' +
        '[role="checkbox"], [role="radio"], [role="combobox"], [role="tab"], [role="menuitem"], ' +
        '[role="option"]',
    ),
  );
  const results: RawInteractable[] = [];
  const accessibleApi = (
    globalThis as unknown as {
      __yantra?: {
        describeAccessible?(element: Element): { readonly name: string };
      };
    }
  ).__yantra;

  for (const [selectorIndex, element] of candidates.entries()) {
    const role = computeRole(element);
    const kind = role === null ? undefined : kindByRole[role];
    if (role === null || kind === undefined) continue;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    const currentValue = computeValue(element);
    results.push({
      role,
      name: computeName(element),
      kind,
      disabled:
        ('disabled' in element && Boolean((element as HTMLInputElement).disabled)) ||
        element.getAttribute('aria-disabled') === 'true',
      top: rect.top,
      left: rect.left,
      group: computeGroup(element),
      scope: computeScope(element),
      value: currentValue.value,
      valuePresent: currentValue.valuePresent,
      checked: computeChecked(element),
      expanded: readAriaBoolean(element, 'aria-expanded'),
      selected: computeSelected(element),
      visible:
        rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== 'hidden' &&
        style.display !== 'none',
      selectorIndex,
    });
  }
  return results;

  function computeRole(element: HTMLElement): string | null {
    const explicit = element.getAttribute('role');
    if (explicit) return explicit;
    const tag = element.tagName.toLowerCase();
    if (tag === 'button') return 'button';
    if (tag === 'a') return 'link';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag !== 'input') return null;
    const type = (element as HTMLInputElement).type.toLowerCase();
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (['submit', 'button', 'reset', 'image'].includes(type)) return 'button';
    return 'textbox';
  }

  function computeName(element: HTMLElement): string | null {
    try {
      const engineName = accessibleApi?.describeAccessible?.(element).name.trim();
      if (engineName) return truncate(engineName);
    } catch {
      // The injected runtime is best-effort. A page mid-navigation or a
      // degraded test facade must still receive the local fallback below.
    }
    const ariaLabel = element.getAttribute('aria-label')?.trim();
    if (ariaLabel) return truncate(ariaLabel);
    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy
        .trim()
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
        .filter(Boolean)
        .join(' ');
      if (text) return truncate(text);
    }
    const id = element.id;
    if (id) {
      const label = document.querySelector(`label[for="${escapeCss(id)}"]`)?.textContent;
      if (label?.trim()) return truncate(normalize(label));
    }
    const parentLabel = element.closest('label')?.textContent;
    if (parentLabel?.trim()) return truncate(normalize(parentLabel));
    // Options carry their label as text content, like buttons and links do, and
    // an unnamed option is unusable — name matching is the only way to pick one.
    if (
      element.matches(
        'button,a,[role="button"],[role="link"],[role="option"],[role="menuitem"],[role="tab"]',
      )
    ) {
      const text = element.textContent?.trim();
      if (text) return truncate(normalize(text));
    }
    const fallback =
      element.getAttribute('placeholder')?.trim() ?? element.getAttribute('title')?.trim();
    return fallback ? truncate(fallback) : null;
  }

  function computeGroup(element: HTMLElement): string | null {
    const groupSelector =
      '[role="dialog"], [role="alertdialog"], [role="listbox"], [role="menu"], ' +
      '[role="grid"], [role="table"], [role="group"], [role="region"], ' +
      '[role="tabpanel"], table, [aria-label], [aria-labelledby]';
    let ancestor = element.parentElement;
    for (let depth = 0; ancestor && ancestor !== document.body && depth < 8; depth += 1) {
      if (ancestor.matches(groupSelector)) {
        const ariaLabel = ancestor.getAttribute('aria-label');
        if (ariaLabel?.trim()) return truncateGroup(normalize(ariaLabel));

        const labelledBy = ancestor.getAttribute('aria-labelledby');
        if (labelledBy) {
          const text = labelledBy
            .trim()
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent ?? '')
            .filter((part) => part.trim().length > 0)
            .join(' ');
          if (text.trim()) return truncateGroup(normalize(text));
        }

        if (ancestor instanceof HTMLTableElement) {
          const caption = ancestor.caption?.textContent;
          if (caption?.trim()) return truncateGroup(normalize(caption));
        }

        const heading = ancestor.querySelector<HTMLElement>(
          'h1,h2,h3,h4,h5,h6,[role="heading"]',
        )?.textContent;
        return heading?.trim() ? truncateGroup(normalize(heading)) : null;
      }
      ancestor = ancestor.parentElement;
    }
    return null;
  }

  function computeScope(element: HTMLElement): 'dialog' | 'page' {
    const scopeSelector =
      '[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open], ' +
      '[role="listbox"], [role="menu"], [role="grid"]';
    let ancestor = element.parentElement;
    while (ancestor && ancestor !== document.body) {
      if (ancestor.matches(scopeSelector) && isVisibleContainer(ancestor)) return 'dialog';
      ancestor = ancestor.parentElement;
    }
    return 'page';
  }

  function isVisibleContainer(element: HTMLElement): boolean {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return (
      rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
    );
  }

  function computeValue(element: HTMLElement): {
    readonly value: string | null;
    readonly valuePresent: boolean;
  } {
    let raw: string | null = null;
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      raw = element.value;
    } else if (element instanceof HTMLSelectElement) {
      const option = element.selectedOptions[0];
      raw = option ? option.label || option.text : '';
    } else if (element.matches('[contenteditable]')) {
      raw = element.textContent ?? '';
    }
    if (raw === null) return { value: null, valuePresent: false };

    const autocomplete = element.getAttribute('autocomplete') ?? '';
    const withheld =
      element.matches('input[type="password"]') ||
      /\b(current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp)\b/i.test(
        autocomplete,
      ) ||
      element.hasAttribute('data-yantra-secret');
    if (withheld) return { value: null, valuePresent: raw.length > 0 };

    const value = normalize(raw);
    return { value: value.length > 0 ? truncateValue(value) : null, valuePresent: false };
  }

  function computeChecked(element: HTMLElement): boolean | null {
    if (
      element instanceof HTMLInputElement &&
      (element.type.toLowerCase() === 'checkbox' || element.type.toLowerCase() === 'radio')
    ) {
      return element.checked;
    }
    return readAriaBoolean(element, 'aria-checked');
  }

  function computeSelected(element: HTMLElement): boolean | null {
    const selected = readAriaBoolean(element, 'aria-selected');
    if (selected !== null) return selected;
    const current = element.getAttribute('aria-current');
    return current !== null && current.toLowerCase() !== 'false' ? true : null;
  }

  function readAriaBoolean(element: HTMLElement, attribute: string): boolean | null {
    const value = element.getAttribute(attribute)?.toLowerCase();
    if (value === 'true') return true;
    if (value === 'false') return false;
    return null;
  }

  function normalize(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
  }
  function truncate(text: string): string {
    return text.length > 200 ? text.slice(0, 200) : text;
  }
  function truncateGroup(text: string): string {
    return text.length > 80 ? text.slice(0, 80) : text;
  }
  function truncateValue(text: string): string {
    return text.length > 120 ? text.slice(0, 120) : text;
  }
  function escapeCss(value: string): string {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
    return value.replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character}`);
  }
}
