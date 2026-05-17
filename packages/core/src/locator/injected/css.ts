/// <reference lib="dom" />

/**
 * CSS selector strategy: query by selector + unique CSS generator.
 *
 * The generator produces the shortest CSS selector that uniquely identifies
 * an element in the document, using a stable-class heuristic to filter out
 * hash-randomized / CSS-Modules-style class names.
 */

/**
 * Stable-class rejection patterns. A class name is unstable if it matches any:
 * - /^css-/ — common CSS-in-JS prefix
 * - /^[a-z0-9]{5,}$/i — short opaque hash (CSS Modules)
 * - /-\d{4,}$/ — trailing numeric hash
 * - Classes where sibling elements share the same class but differ only in a trailing digit
 */
const UNSTABLE_PATTERNS = [
  /^css-/i,
  // Mixed alphanumeric 5+ chars with at least one digit — looks like a CSS Modules hash
  // (e.g. "abc1d", "f8a3e"). Purely alphabetic strings like "header" are kept.
  /^(?=[a-z0-9]*\d)[a-z0-9]{5,}$/i,
  /-\d{4,}$/,
  /^[a-z]+-\d+$/i, // e.g. item-123
] as const;

const DEFAULT_DEPTH_CAP = 8;

/**
 * Queries the document using an arbitrary CSS selector in strict mode.
 *
 * @param selector - CSS selector string
 * @returns All matching elements
 * @throws {SyntaxError} when the selector is syntactically invalid
 */
export function queryCss(selector: string): Element[] {
  // Let the browser throw SyntaxError for invalid selectors
  return Array.from(document.querySelectorAll(selector));
}

/**
 * Generates the shortest unique CSS selector for the given element.
 *
 * Strategy (in priority order at each ancestor level):
 * 1. `[id="..."]` if the id appears exactly once in the document
 * 2. `[data-testid="..."]` terminates immediately
 * 3. `tagname.class1.class2` using only stable class names
 * 4. `tagname:nth-of-type(n)` as positional fallback
 *
 * @param el - The element to generate a selector for
 * @param options - Optional overrides for depth cap and unstable patterns
 * @returns A unique CSS selector, or null if one cannot be found within the depth cap
 */
export function generateUniqueCss(
  el: Element,
  options: {
    readonly depthCap?: number;
    readonly unstablePatterns?: readonly RegExp[];
  } = {},
): string | null {
  const depthCap = options.depthCap ?? DEFAULT_DEPTH_CAP;
  const unstable = options.unstablePatterns ?? UNSTABLE_PATTERNS;

  const segments: string[] = [];
  let current: Element | null = el;
  let depth = 0;

  while (current && current !== document.documentElement && depth < depthCap) {
    const segment = buildSegment(current, unstable);
    segments.unshift(segment);

    // Check uniqueness with accumulated path
    const candidate = segments.join(' > ');
    if (document.querySelectorAll(candidate).length === 1) {
      return candidate;
    }

    current = current.parentElement;
    depth++;
  }

  // Final check at depth cap
  const candidate = segments.join(' > ');
  if (document.querySelectorAll(candidate).length === 1) {
    return candidate;
  }

  return null;
}

/** Builds a single selector segment for one element in the tree. */
function buildSegment(el: Element, unstablePatterns: readonly RegExp[]): string {
  const tag = el.tagName.toLowerCase();

  // data-testid terminates immediately (most stable possible selector)
  for (const attr of ['data-testid', 'data-test-id', 'data-qa', 'data-test']) {
    const val = el.getAttribute(attr);
    if (val) return `[${attr}="${CSS.escape(val)}"]`;
  }

  // Unique id selector
  const id = el.getAttribute('id');
  if (id && document.querySelectorAll(`#${CSS.escape(id)}`).length === 1) {
    return `#${CSS.escape(id)}`;
  }

  // Stable class names
  const stableClasses = Array.from(el.classList).filter(
    (cls) => !unstablePatterns.some((p) => p.test(cls)),
  );

  if (stableClasses.length > 0) {
    return `${tag}.${stableClasses.map((c) => CSS.escape(c)).join('.')}`;
  }

  // Positional fallback: nth-of-type
  const nthOfType = getNthOfType(el);
  return `${tag}:nth-of-type(${nthOfType})`;
}

/** Returns the 1-based nth-of-type position of the element among its parent's children. */
function getNthOfType(el: Element): number {
  const tag = el.tagName;
  const parent = el.parentElement;
  if (!parent) return 1;

  let n = 1;
  for (const sibling of Array.from(parent.children)) {
    if (sibling === el) return n;
    if (sibling.tagName === tag) n++;
  }
  return n;
}

/** Returns whether a class name is considered stable (not hash-like). */
export function isStableClassName(
  cls: string,
  patterns: readonly RegExp[] = UNSTABLE_PATTERNS,
): boolean {
  return !patterns.some((p) => p.test(cls));
}
