/// <reference lib="dom" />
/**
 * In-page interactable scanner (FEAT-020 TASK-003).
 *
 * Runs inside the browser page — either directly (jsdom in tests) or handed
 * straight to `Page.evaluate(fn)` in production. `evaluate` serializes the
 * function via `.toString()` and re-executes it in the page context, so this
 * function is deliberately **self-contained**: zero imports, zero closures
 * over anything outside its own body (the same constraint the locator
 * engine's injected script and the recorder overlay's `descriptor-builder.ts`
 * operate under, just small enough here not to need a separate esbuild
 * bundle step).
 *
 * Returns every candidate element with enough raw signal (role, name, kind,
 * disabled, viewport position, visibility) for `interactables.ts` — a plain
 * Node module — to rank, filter, and cap to the protocol's 30-element limit.
 * This module never reads or returns an element's current value/text beyond
 * its accessible name — only structural fingerprint fields.
 */

/** One candidate element's raw signal, before ranking/capping. */
export interface RawInteractable {
  readonly role: string;
  readonly name: string | null;
  readonly kind: 'button' | 'link' | 'input' | 'select';
  readonly disabled: boolean;
  /** Viewport Y position — used as the prominence (reading-order) key. */
  readonly top: number;
  readonly visible: boolean;
}

const KIND_BY_ROLE: Record<string, 'button' | 'link' | 'input' | 'select'> = {
  button: 'button',
  link: 'link',
  textbox: 'input',
  searchbox: 'input',
  checkbox: 'input',
  radio: 'input',
  combobox: 'select',
  listbox: 'select',
};

const MAX_NAME_LEN = 200;

/**
 * Scans the current page for interactable candidates (buttons, links, form
 * controls) and returns their raw structural signal. Self-contained — see
 * module doc for the serialization constraint.
 */
export function scanInteractablesInPage(): RawInteractable[] {
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>(
      'button, a[href], input, select, textarea, [role="button"], [role="link"], ' +
        '[role="checkbox"], [role="radio"], [role="combobox"], [role="tab"], [role="menuitem"]',
    ),
  );

  const results: RawInteractable[] = [];

  for (const el of candidates) {
    const role = computeRoleInPage(el);
    if (role === null) continue;
    const kind = KIND_BY_ROLE[role];
    if (kind === undefined) continue;

    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    const visible =
      rect.width > 0 &&
      rect.height > 0 &&
      style.visibility !== 'hidden' &&
      style.display !== 'none';

    results.push({
      role,
      name: computeNameInPage(el),
      kind,
      disabled: isDisabledInPage(el),
      top: rect.top,
      visible,
    });
  }

  return results;
}

function computeRoleInPage(el: HTMLElement): string | null {
  const explicit = el.getAttribute('role');
  if (explicit) return explicit;

  const tag = el.tagName.toLowerCase();
  if (tag === 'button') return 'button';
  if (tag === 'a') return 'link';
  if (tag === 'select') return 'combobox';
  if (tag === 'textarea') return 'textbox';
  if (tag === 'input') {
    const type = (el as HTMLInputElement).type?.toLowerCase();
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') {
      return 'button';
    }
    return 'textbox';
  }
  return null;
}

function computeNameInPage(el: HTMLElement): string | null {
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel && ariaLabel.trim().length > 0) {
    return truncateName(ariaLabel.trim());
  }

  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const parts = labelledBy
      .trim()
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
      .filter((text) => text.length > 0);
    if (parts.length > 0) return truncateName(parts.join(' '));
  }

  const id = el.getAttribute('id');
  if (id) {
    const label = document.querySelector(`label[for="${cssEscape(id)}"]`);
    if (label?.textContent?.trim()) return truncateName(normalizeWhitespace(label.textContent));
  }

  const parentLabel = el.closest('label');
  if (parentLabel?.textContent?.trim()) {
    return truncateName(normalizeWhitespace(parentLabel.textContent));
  }

  const tag = el.tagName.toLowerCase();
  if (tag === 'button' || tag === 'a') {
    const text = (el.textContent ?? '').trim();
    if (text.length > 0) return truncateName(normalizeWhitespace(text));
  }

  const placeholder = el.getAttribute('placeholder');
  if (placeholder && placeholder.trim().length > 0) {
    return truncateName(placeholder.trim());
  }

  const title = el.getAttribute('title');
  if (title && title.trim().length > 0) {
    return truncateName(title.trim());
  }

  return null;
}

function isDisabledInPage(el: HTMLElement): boolean {
  if ('disabled' in el && Boolean((el as HTMLInputElement).disabled)) {
    return true;
  }
  return el.getAttribute('aria-disabled') === 'true';
}

function truncateName(name: string): string {
  return name.length > MAX_NAME_LEN ? name.slice(0, MAX_NAME_LEN) : name;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Minimal `CSS.escape` fallback — real browsers have `CSS.escape` natively. */
function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  return value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
}
