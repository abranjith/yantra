/// <reference lib="dom" />

/**
 * Label-for and aria-labelledby resolution strategy.
 *
 * Resolves to the LABELLED CONTROL (the input/select/textarea), not the label.
 * Resolution order per WAI-ARIA accessible name specification:
 *   1. aria-labelledby on the control points to this label
 *   2. <label for="id"> explicit association
 *   3. <label>wrapped <input></label> implicit association
 *   4. aria-label attribute direct match
 */

import { matchText } from './text.js';

/**
 * Finds form controls whose accessible label text matches the given matcher.
 *
 * Returns the labelled CONTROL elements (inputs, selects, textareas), not the labels.
 *
 * @param text - Label text to match against
 * @param exact - Whether to require exact match (default true)
 * @returns Array of matching control elements
 */
export function findByLabel(text: string | RegExp, exact = true): Element[] {
  const results: Element[] = [];

  // Strategy 1: <label for="id"> explicit association
  // Find labels whose text matches, then find the associated control
  const allLabels = document.querySelectorAll('label');
  for (const label of Array.from(allLabels)) {
    const labelText = getLabelText(label);
    if (!matchText(labelText, text, exact)) continue;

    const forAttr = label.getAttribute('for');
    if (forAttr) {
      // Explicit association via `for` attribute
      const control = document.getElementById(forAttr);
      if (control && isFormControl(control)) {
        if (!results.includes(control)) results.push(control);
      }
    } else {
      // Implicit association: label wraps the control
      const control = label.querySelector('input, select, textarea, button');
      if (control && !results.includes(control)) {
        results.push(control);
      }
    }
  }

  // Strategy 2: aria-labelledby pointing to an element whose text matches
  const allControls = document.querySelectorAll('input, select, textarea, button, [role]');
  for (const control of Array.from(allControls)) {
    if (results.includes(control)) continue;

    const labelledBy = control.getAttribute('aria-labelledby');
    if (labelledBy) {
      const ids = labelledBy.trim().split(/\s+/);
      const labelText = ids
        .map((id: string) => {
          const ref = document.getElementById(id);
          return ref ? (ref.textContent ?? '') : '';
        })
        .join(' ');
      if (matchText(labelText, text, exact)) {
        results.push(control);
        continue;
      }
    }

    // Strategy 3: aria-label attribute
    const ariaLabel = control.getAttribute('aria-label') ?? '';
    if (ariaLabel && matchText(ariaLabel, text, exact)) {
      results.push(control);
    }
  }

  return results;
}

/** Extracts the visible text of a <label> element, excluding nested inputs. */
function getLabelText(label: HTMLLabelElement): string {
  const clone = label.cloneNode(true) as HTMLElement;
  const nestedInputs = clone.querySelectorAll('input, select, textarea');
  nestedInputs.forEach((n) => n.remove());
  return (clone.textContent ?? '').trim();
}

function isFormControl(el: Element): boolean {
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'BUTTON';
}
