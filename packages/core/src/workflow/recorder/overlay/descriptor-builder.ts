/// <reference lib="dom" />
/**
 * In-page ElementDescriptor builder.
 *
 * Runs inside the browser (CDP-injected), NOT in Node. Zero Node.js APIs.
 * Builds a sanitized structural fingerprint of a DOM element that never
 * carries the element's input VALUE — only structural metadata for locating it.
 *
 * Imported by event-listeners.ts. Tested with jsdom (no real browser needed).
 */

/** Attribute keys whitelisted for sampling — must match RecordingDraftSchema. */
const SAMPLED_ATTR_KEYS: readonly string[] = [
  'id',
  'name',
  'data-testid',
  'data-qa',
  'data-cy',
  'placeholder',
  'aria-label',
  'href',
  'type',
];

const MAX_TEXT_LENGTH = 200;
const MAX_ATTR_VALUE_LENGTH = 100;
const XPATH_MAX_LENGTH = 200;

/** Regex for common credential-shaped strings — applied to attr values. */
const CREDENTIAL_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9-]{10,}/,
  /ghp_[A-Za-z0-9]{10,}/,
  /AKIA[A-Z0-9]{16}/,
  /eyJ[A-Za-z0-9_-]{10,}/,
  /xoxb-[A-Za-z0-9-]{10,}/,
  /gho_[A-Za-z0-9]{10,}/,
  /glpat-[A-Za-z0-9_-]{10,}/,
];

/** Password field aria-label allowlist — names that are legitimately structural. */
const PASSWORD_ARIA_ALLOWLIST = new Set([
  'password',
  'passcode',
  'pin',
  'current password',
  'new password',
  'confirm password',
  'passphrase',
]);

// ---------------------------------------------------------------------------
// Types (mirrored from protocol, but must not import Node-side modules)
// ---------------------------------------------------------------------------

export interface ElementDescriptorInPage {
  tag: string;
  role: string | null;
  accessible_name: string | null;
  visible_text: string | null;
  attrs_sample: Partial<Record<string, string>>;
  bounding_rect: { x: number; y: number; width: number; height: number };
  in_iframe: boolean;
  xpath_for_debug: string;
}

// ---------------------------------------------------------------------------
// ARIA role computation (lite)
// ---------------------------------------------------------------------------

const IMPLICIT_ROLE_MAP: Record<string, string> = {
  a: 'link',
  button: 'button',
  select: 'combobox',
  textarea: 'textbox',
  input: 'textbox', // refined by type below
  checkbox: 'checkbox',
  radio: 'radio',
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  h5: 'heading',
  h6: 'heading',
  img: 'img',
  table: 'table',
  tr: 'row',
  td: 'cell',
  th: 'columnheader',
  nav: 'navigation',
  main: 'main',
  form: 'form',
  menu: 'menu',
  li: 'listitem',
  ul: 'list',
  ol: 'list',
  dialog: 'dialog',
};

function computeRole(el: Element): string | null {
  const explicit = el.getAttribute('role');
  if (explicit) return explicit;

  const tag = el.tagName.toLowerCase();
  if (tag === 'input') {
    const type = (el as HTMLInputElement).type?.toLowerCase();
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'submit' || type === 'button' || type === 'reset') return 'button';
    if (type === 'image') return 'button';
    return 'textbox';
  }
  return IMPLICIT_ROLE_MAP[tag] ?? null;
}

// ---------------------------------------------------------------------------
// Accessible name computation (ARIA lite)
// ---------------------------------------------------------------------------

function computeAccessibleName(el: Element): string | null {
  // 1. aria-labelledby
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const ids = labelledBy.trim().split(/\s+/);
    const parts = ids
      .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
      .filter(Boolean);
    if (parts.length > 0) return truncate(parts.join(' '), MAX_TEXT_LENGTH);
  }

  // 2. aria-label
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel?.trim()) return truncate(ariaLabel.trim(), MAX_TEXT_LENGTH);

  // 3. <label for="id">
  const id = el.getAttribute('id');
  if (id) {
    const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
    if (label) {
      const text = labelText(label);
      if (text) return truncate(text, MAX_TEXT_LENGTH);
    }
  }

  // 4. <label> parent wrapping this element
  const parentLabel = el.closest('label');
  if (parentLabel) {
    const text = labelText(parentLabel);
    if (text) return truncate(text, MAX_TEXT_LENGTH);
  }

  // 5. Button/link text content
  const tag = el.tagName.toLowerCase();
  if (tag === 'button' || tag === 'a') {
    const text = (el.textContent ?? '').trim();
    if (text) return truncate(normalizeWhitespace(text), MAX_TEXT_LENGTH);
  }

  // 6. placeholder
  const placeholder = el.getAttribute('placeholder');
  if (placeholder?.trim()) return truncate(placeholder.trim(), MAX_TEXT_LENGTH);

  // 7. title
  const title = el.getAttribute('title');
  if (title?.trim()) return truncate(title.trim(), MAX_TEXT_LENGTH);

  return null;
}

/** Extract visible text of a label, excluding its child form controls. */
function labelText(label: Element): string {
  const clone = label.cloneNode(true) as Element;
  clone.querySelectorAll('input, select, textarea, button').forEach((n) => n.remove());
  return normalizeWhitespace(clone.textContent ?? '');
}

// ---------------------------------------------------------------------------
// Attribute sampling with sanitization
// ---------------------------------------------------------------------------

function sampleAttrs(el: Element): Partial<Record<string, string>> {
  const result: Partial<Record<string, string>> = {};
  const isPassword =
    el.tagName.toLowerCase() === 'input' &&
    (el as HTMLInputElement).type?.toLowerCase() === 'password';

  for (const key of SAMPLED_ATTR_KEYS) {
    const raw = el.getAttribute(key);
    if (raw === null) continue;

    // Skip value and checked — these are state, not structure
    if (key === 'value' || key === 'checked') continue;

    let value = sanitizeAttrValue(raw);

    // For password inputs, apply allowlist to aria-label and accessible name
    if (isPassword && key === 'aria-label') {
      if (!PASSWORD_ARIA_ALLOWLIST.has(value.toLowerCase())) {
        value = '<password-field>';
      }
    }

    result[key] = value;
  }
  return result;
}

function sanitizeAttrValue(raw: string): string {
  // Truncate
  let value = raw.slice(0, MAX_ATTR_VALUE_LENGTH);
  // Strip control characters (intentional: U+0000–U+001F)
  // eslint-disable-next-line no-control-regex
  value = value.replace(/[\x00-\x1f]/g, '');
  // Defang credential patterns
  for (const pattern of CREDENTIAL_PATTERNS) {
    if (pattern.test(value)) return '<defanged>';
  }
  return value;
}

// ---------------------------------------------------------------------------
// XPath generator (absolute, minimal, capped)
// ---------------------------------------------------------------------------

function generateXpath(el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;

  while (node !== null && node.nodeType === Node.ELEMENT_NODE) {
    const currentNode: Element = node;
    const tag = currentNode.tagName.toLowerCase();
    const parent: Element | null = currentNode.parentElement;
    let index = 1;
    let sameTagSiblings = 0;

    if (parent !== null) {
      const matching = Array.from(parent.children).filter(
        (c: Element) => c.tagName.toLowerCase() === tag,
      );
      sameTagSiblings = matching.length;
      if (matching.length > 1) {
        index = matching.indexOf(currentNode) + 1;
      }
    }

    parts.unshift(sameTagSiblings > 1 ? `${tag}[${index}]` : tag);
    node = parent;
  }

  const xpath = '/' + parts.join('/');
  return xpath.length > XPATH_MAX_LENGTH ? xpath.slice(0, XPATH_MAX_LENGTH) : xpath;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function isInIframe(el: Element): boolean {
  try {
    return el.ownerDocument !== window.document;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Builds a sanitized structural fingerprint of a DOM element.
 *
 * Runs entirely in-page (browser context). Never reads or retains the element's
 * current value or any state that constitutes PII.
 *
 * @param el - The element to fingerprint
 * @returns ElementDescriptor safe for inclusion in the captured action payload
 *
 * @example
 * const descriptor = buildElementDescriptor(document.querySelector('button')!);
 * // descriptor.tag === 'button'; descriptor.role === 'button'; etc.
 */
export function buildElementDescriptor(el: Element): ElementDescriptorInPage {
  const rect = el.getBoundingClientRect();
  const tag = el.tagName.toLowerCase();
  const role = computeRole(el);
  const accessible_name = computeAccessibleName(el);

  let visible_text: string | null = null;
  const rawText = (el.textContent ?? '').trim();
  if (rawText) {
    visible_text = truncate(normalizeWhitespace(rawText), MAX_TEXT_LENGTH);
  }

  return {
    tag,
    role,
    accessible_name,
    visible_text,
    attrs_sample: sampleAttrs(el),
    bounding_rect: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
    in_iframe: isInIframe(el),
    xpath_for_debug: generateXpath(el),
  };
}
