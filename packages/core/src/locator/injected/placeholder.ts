/// <reference lib="dom" />

/**
 * Placeholder and name-attribute strategies.
 * Fallback for unlabeled inputs when label-for or ARIA strategies fail.
 */

import { matchText } from './text.js';

/**
 * Finds inputs and textareas by their placeholder attribute.
 *
 * @param text - Placeholder text to match
 * @param exact - Whether to require exact match (default true)
 * @returns Matching input/textarea elements
 *
 * @example
 * findByPlaceholder('Enter email') // finds <input placeholder="Enter email">
 */
export function findByPlaceholder(text: string | RegExp, exact = true): Element[] {
  const controls = document.querySelectorAll('input[placeholder], textarea[placeholder]');
  const results: Element[] = [];

  for (const el of Array.from(controls)) {
    const ph = el.getAttribute('placeholder') ?? '';
    if (matchText(ph, text, exact)) {
      results.push(el);
    }
  }

  return results;
}

/**
 * Finds inputs by their `name` attribute (exact match).
 * This is a last-resort for unlabeled form controls that lack placeholder.
 *
 * @param name - The name attribute value
 * @returns Matching elements
 */
export function findByNameAttribute(name: string): Element[] {
  const escaped = CSS.escape(name);
  return Array.from(document.querySelectorAll(`[name="${escaped}"]`));
}
