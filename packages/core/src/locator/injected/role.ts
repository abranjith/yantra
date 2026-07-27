/// <reference lib="dom" />

/**
 * ARIA computed-role and accessible-name resolution.
 *
 * Ports the relevant parts of Playwright's roleUtils algorithm (Apache-2.0).
 * Source attribution: playwright-core/src/server/injected/roleUtils.ts
 * License: Apache-2.0 (https://www.apache.org/licenses/LICENSE-2.0)
 */

import type { AriaRole } from '../types.js';

/**
 * Maps HTML element tag names to their implicit ARIA roles.
 * Per WAI-ARIA 1.2 §5 (implicit ARIA semantics).
 */
const IMPLICIT_ROLE_MAP: ReadonlyMap<string, AriaRole> = new Map([
  ['A', 'link'], // only if href present — checked in getRole()
  ['AREA', 'link'],
  ['ARTICLE', 'article'],
  ['ASIDE', 'complementary'],
  ['BUTTON', 'button'],
  ['DATALIST', 'listbox'],
  ['DD', 'definition'],
  ['DETAILS', 'group'],
  ['DIALOG', 'dialog'],
  ['DFN', 'definition'],
  ['FIELDSET', 'group'],
  ['FIGURE', 'figure'],
  ['FOOTER', 'contentinfo'],
  ['FORM', 'form'],
  ['H1', 'heading'],
  ['H2', 'heading'],
  ['H3', 'heading'],
  ['H4', 'heading'],
  ['H5', 'heading'],
  ['H6', 'heading'],
  ['HEADER', 'banner'],
  ['HR', 'separator'],
  ['IMG', 'img'],
  ['LI', 'listitem'],
  ['MAIN', 'main'],
  ['MATH', 'math'],
  ['MENU', 'list'],
  ['METER', 'meter'],
  ['NAV', 'navigation'],
  ['OL', 'list'],
  ['OPTION', 'option'],
  ['OUTPUT', 'status'],
  ['P', 'paragraph'],
  ['PROGRESS', 'progressbar'],
  ['SEARCH', 'search'],
  ['SECTION', 'region'],
  ['SELECT', 'listbox'],
  ['SUMMARY', 'button'],
  ['TABLE', 'table'],
  ['TBODY', 'rowgroup'],
  ['TD', 'cell'],
  ['TEXTAREA', 'textbox'],
  ['TFOOT', 'rowgroup'],
  ['TH', 'columnheader'],
  ['THEAD', 'rowgroup'],
  ['TR', 'row'],
  ['UL', 'list'],
]);

/** Input type → implicit ARIA role. */
const INPUT_TYPE_ROLE_MAP: ReadonlyMap<string, AriaRole> = new Map([
  ['button', 'button'],
  ['checkbox', 'checkbox'],
  ['color', 'slider'],
  ['email', 'textbox'],
  ['file', 'button'],
  ['image', 'button'],
  ['month', 'spinbutton'],
  ['number', 'spinbutton'],
  ['radio', 'radio'],
  ['range', 'slider'],
  ['reset', 'button'],
  ['search', 'searchbox'],
  ['submit', 'button'],
  ['tel', 'textbox'],
  ['text', 'textbox'],
  ['time', 'spinbutton'],
  ['url', 'textbox'],
  ['week', 'spinbutton'],
]);

const VALID_ARIA_ROLES = new Set<string>([
  'alert',
  'alertdialog',
  'application',
  'article',
  'banner',
  'button',
  'cell',
  'checkbox',
  'columnheader',
  'combobox',
  'complementary',
  'contentinfo',
  'definition',
  'dialog',
  'directory',
  'document',
  'feed',
  'figure',
  'form',
  'grid',
  'gridcell',
  'group',
  'heading',
  'img',
  'link',
  'list',
  'listbox',
  'listitem',
  'log',
  'main',
  'marquee',
  'math',
  'menu',
  'menubar',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'navigation',
  'none',
  'note',
  'option',
  'paragraph',
  'presentation',
  'progressbar',
  'radio',
  'radiogroup',
  'region',
  'row',
  'rowgroup',
  'rowheader',
  'scrollbar',
  'search',
  'searchbox',
  'separator',
  'slider',
  'spinbutton',
  'status',
  'switch',
  'tab',
  'table',
  'tablist',
  'tabpanel',
  'term',
  'textbox',
  'timer',
  'toolbar',
  'tooltip',
  'tree',
  'treegrid',
  'treeitem',
]);

/**
 * Computes the effective ARIA role for an element.
 * Explicit role attribute wins (if valid); implicit role is the fallback.
 *
 * @param el - The element to inspect
 * @returns The ARIA role, or null if none applies
 */
export function getRole(el: Element): AriaRole | null {
  // Explicit role attribute wins for valid roles
  const explicitRole = el.getAttribute('role')?.trim().split(/\s+/)[0] ?? '';
  if (explicitRole && VALID_ARIA_ROLES.has(explicitRole)) {
    return explicitRole as AriaRole;
  }

  const tag = el.tagName;

  // Special cases for <a> and <area>: only link role when href is present
  if (tag === 'A' || tag === 'AREA') {
    return el.hasAttribute('href') ? 'link' : null;
  }

  // Special case for <input>: role depends on type attribute
  if (tag === 'INPUT') {
    const inputType = (el.getAttribute('type') ?? 'text').toLowerCase();
    if (inputType === 'hidden') return null;
    return INPUT_TYPE_ROLE_MAP.get(inputType) ?? 'textbox';
  }

  // <section> is only "region" when it has an accessible name.
  //
  // This must consult the *explicit* name only. Asking for the full accessible
  // name would re-enter `getAccessibleName`, whose content branch calls back
  // into `getRole` — unbounded mutual recursion that blew the stack on any
  // page containing an unnamed `<section>`, which is most of them. Per
  // accname, a section is never named by its own content anyway, so the
  // explicit name is the correct input here as well as the terminating one.
  if (tag === 'SECTION') {
    return explicitAccessibleName(el) ? 'region' : null;
  }

  return IMPLICIT_ROLE_MAP.get(tag) ?? null;
}

/**
 * Computes the accessible name for an element per the WAI-ARIA accessible name
 * computation algorithm (https://www.w3.org/TR/accname-1.1/).
 *
 * Priority order: aria-labelledby > aria-label > native label (for form controls)
 * > placeholder > title > inner text (for non-form elements).
 *
 * @param el - The element to compute an accessible name for
 * @returns The accessible name string (may be empty)
 */
export function getAccessibleName(el: Element): string {
  const explicit = explicitAccessibleName(el);
  if (explicit) return explicit;

  // For buttons, headings, links — inner text content
  const role = getRole(el);
  if (
    role === 'button' ||
    role === 'link' ||
    role === 'heading' ||
    role === 'tab' ||
    role === 'menuitem'
  ) {
    return (el.textContent ?? '').trim();
  }

  return '';
}

/**
 * The accessible name an element declares, independent of its role:
 * aria-labelledby > aria-label > native label > placeholder > title.
 *
 * Split out from {@link getAccessibleName} so `getRole` can ask "is this
 * element named?" without triggering the role → name → role cycle. Every
 * source here is declarative, so this function never consults the role.
 */
function explicitAccessibleName(el: Element): string {
  // aria-labelledby: space-separated IDs, concatenated text content
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const ids = labelledBy.trim().split(/\s+/);
    const parts = ids.map((id) => {
      const ref = document.getElementById(id);
      return ref ? (ref.textContent ?? '') : '';
    });
    const name = parts.join(' ').trim();
    if (name) return name;
  }

  // aria-label: explicit override
  const ariaLabel = el.getAttribute('aria-label')?.trim();
  if (ariaLabel) return ariaLabel;

  // Native HTML label (for form controls)
  const nativeLabel = getNativeLabel(el);
  if (nativeLabel) return nativeLabel;

  // placeholder (for inputs/textareas)
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const ph = el.placeholder?.trim();
    if (ph) return ph;
  }

  // title attribute
  const title = el.getAttribute('title')?.trim();
  if (title) return title;

  return '';
}

/** Resolves the accessible name from the native <label> association. */
function getNativeLabel(el: Element): string {
  // <label for="id"> association
  const id = el.getAttribute('id');
  if (id) {
    const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
    if (label) return (label.textContent ?? '').trim();
  }

  // Ancestor <label> wrapping this element
  const ancestorLabel = el.closest('label');
  if (ancestorLabel) {
    // Text of label excluding the input's own text
    const clone = ancestorLabel.cloneNode(true) as HTMLElement;
    const nestedInputs = clone.querySelectorAll('input, select, textarea');
    nestedInputs.forEach((n) => n.remove());
    return (clone.textContent ?? '').trim();
  }

  return '';
}
