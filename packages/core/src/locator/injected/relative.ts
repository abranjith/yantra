/// <reference lib="dom" />

/**
 * Relative-anchor strategy: resolves elements by structural relationship to an anchor.
 *
 * The anchor element is resolved first by the caller (via another LocatorIntent).
 * This module then finds the target element via the declared RelativeRelation.
 *
 * @example "the input next to the 'Username' label"
 *   → anchor = label "Username", relation = "next-sibling", targetRole = "textbox"
 */

import type { AriaRole, RelativeRelation } from '../types.js';

import { getRole } from './role.js';

/**
 * Resolves elements by their structural relationship to an anchor element.
 *
 * @param anchor - The anchor element to resolve relative to
 * @param relation - The structural relationship to apply
 * @param targetRoleFilter - Optional ARIA role filter for the target
 * @returns All matching elements (caller applies strict-mode checks)
 */
export function resolveRelative(
  anchor: Element,
  relation: RelativeRelation,
  targetRoleFilter?: AriaRole,
): Element[] {
  const candidates: Element[] = [];

  switch (relation) {
    case 'next-sibling': {
      let sibling = anchor.nextElementSibling;
      while (sibling !== null) {
        if (matchesRoleFilter(sibling, targetRoleFilter)) {
          candidates.push(sibling);
          break; // take first matching sibling
        }
        sibling = sibling.nextElementSibling;
      }
      break;
    }

    case 'previous-sibling': {
      let sibling = anchor.previousElementSibling;
      while (sibling !== null) {
        if (matchesRoleFilter(sibling, targetRoleFilter)) {
          candidates.push(sibling);
          break;
        }
        sibling = sibling.previousElementSibling;
      }
      break;
    }

    case 'following': {
      // All elements after anchor in document order
      const all = Array.from(document.querySelectorAll('*'));
      let found = false;
      for (const el of all) {
        if (!found) {
          if (el === anchor) found = true;
          continue;
        }
        if (matchesRoleFilter(el, targetRoleFilter)) {
          candidates.push(el);
        }
      }
      break;
    }

    case 'preceding': {
      // All elements before anchor in document order
      const all = Array.from(document.querySelectorAll('*'));
      for (const el of all) {
        if (el === anchor) break;
        if (matchesRoleFilter(el, targetRoleFilter)) {
          candidates.push(el);
        }
      }
      break;
    }

    case 'ancestor': {
      // Closest ancestor matching the role filter
      let parent = anchor.parentElement;
      while (parent !== null) {
        if (matchesRoleFilter(parent, targetRoleFilter)) {
          candidates.push(parent);
          break; // closest wins
        }
        parent = parent.parentElement;
      }
      break;
    }

    case 'descendant': {
      // First matching descendant
      const all = Array.from(anchor.querySelectorAll('*'));
      for (const el of all) {
        if (matchesRoleFilter(el, targetRoleFilter)) {
          candidates.push(el);
          break; // first wins
        }
      }
      break;
    }

    case 'labeled-by': {
      // Find the input associated with the anchor (label → input)
      if (anchor.tagName === 'LABEL') {
        const forAttr = (anchor as HTMLLabelElement).getAttribute('for');
        if (forAttr) {
          const control = document.getElementById(forAttr);
          if (control && matchesRoleFilter(control, targetRoleFilter)) {
            candidates.push(control);
          }
        } else {
          // Implicit label: find the first form control inside
          const control = anchor.querySelector('input, select, textarea');
          if (control && matchesRoleFilter(control, targetRoleFilter)) {
            candidates.push(control);
          }
        }
      }
      break;
    }
  }

  return candidates;
}

function matchesRoleFilter(el: Element, roleFilter?: AriaRole): boolean {
  if (!roleFilter) return true;
  return getRole(el) === roleFilter;
}
