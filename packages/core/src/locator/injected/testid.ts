/// <reference lib="dom" />

/**
 * data-testid strategy with configurable attribute aliases.
 *
 * Iterates attributes in order; collects matches across all attributes.
 * The caller (resolver) applies strict-mode ambiguity checks.
 */

const DEFAULT_TESTID_ATTRIBUTES = ['data-testid', 'data-test-id', 'data-qa', 'data-test'] as const;

/**
 * Finds elements matching the given test-id value.
 *
 * @param value - The expected test-id attribute value
 * @param attributes - Attribute names to probe (in order). Defaults to standard aliases.
 * @returns All matching elements across all probed attributes (order preserved, deduped)
 *
 * @example
 * findByTestId('login-button') // finds [data-testid="login-button"] etc.
 * findByTestId('qa-btn', ['data-qa']) // only checks data-qa
 */
export function findByTestId(
  value: string,
  attributes: readonly string[] = DEFAULT_TESTID_ATTRIBUTES,
): Element[] {
  const seen = new Set<Element>();
  const results: Element[] = [];

  for (const attr of attributes) {
    // Escape value for attribute selector
    const escaped = CSS.escape(value);
    const matches = document.querySelectorAll(`[${attr}="${escaped}"]`);
    for (const el of Array.from(matches)) {
      if (!seen.has(el)) {
        seen.add(el);
        results.push(el);
      }
    }
  }

  return results;
}
