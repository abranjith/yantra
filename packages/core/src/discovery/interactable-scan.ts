/// <reference lib="dom" />

/** One candidate element's raw signal, before ranking/capping. */
export interface RawInteractable {
  readonly role: string;
  readonly name: string | null;
  readonly kind: 'button' | 'link' | 'input' | 'select';
  readonly disabled: boolean;
  readonly top: number;
  readonly visible: boolean;
  /** Position in the scanner's candidate NodeList; never model-visible. */
  readonly selectorIndex?: number;
}

/**
 * Scans buttons, links, and form controls in page context. The complete
 * implementation is nested in this function because Puppeteer serializes only
 * the function body when it is passed to `Page.evaluate`.
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

  for (const [selectorIndex, element] of candidates.entries()) {
    const role = computeRole(element);
    const kind = role === null ? undefined : kindByRole[role];
    if (role === null || kind === undefined) continue;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    results.push({
      role,
      name: computeName(element),
      kind,
      disabled:
        ('disabled' in element && Boolean((element as HTMLInputElement).disabled)) ||
        element.getAttribute('aria-disabled') === 'true',
      top: rect.top,
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
    if (element.matches('button,a,[role="option"],[role="menuitem"],[role="tab"]')) {
      const text = element.textContent?.trim();
      if (text) return truncate(normalize(text));
    }
    const fallback =
      element.getAttribute('placeholder')?.trim() ?? element.getAttribute('title')?.trim();
    return fallback ? truncate(fallback) : null;
  }

  function normalize(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
  }
  function truncate(text: string): string {
    return text.length > 200 ? text.slice(0, 200) : text;
  }
  function escapeCss(value: string): string {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
    return value.replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character}`);
  }
}
