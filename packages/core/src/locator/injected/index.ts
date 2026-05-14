/// <reference lib="dom" />

/**
 * InjectedScript entry point. Compiled to dist/injected.bundle.js by esbuild.
 * Registers window.__yantra with the locator engine API.
 *
 * This file runs in the browser page context — no Node.js imports.
 */

import type { ActionableState, CandidateResolution, HitTargetCheckResult, JsonLocatorIntent } from '../types.js';

import { checkActionableState, isBoundingRectStable, isAttached } from './actionable.js';
import { queryCss } from './css.js';
import { checkHitTarget } from './hit-target.js';
import { findByLabel } from './label.js';
import { findByPlaceholder, findByNameAttribute } from './placeholder.js';
import { resolveRelative } from './relative.js';
import { getAccessibleName, getRole } from './role.js';
import { findByTestId } from './testid.js';
import { matchText } from './text.js';
import { queryXpath } from './xpath.js';

/** Slot holding the most recently resolved element (for callHandle retrieval). */
let resolvedSlot: Element | null = null;

/** Resolves a single candidate intent against the current document. */
function resolveCandidate(encodedIntent: JsonLocatorIntent, strict: boolean): CandidateResolution {
  const elements = findElements(encodedIntent);

  if (elements.length === 0) {
    resolvedSlot = null;
    return { count: 0 };
  }

  if (strict && elements.length > 1) {
    resolvedSlot = null;
    return { count: elements.length };
  }

  // Success: store first match in slot for retrieval via callHandle
  resolvedSlot = elements[0] ?? null;
  return { count: elements.length, slotKey: 'default' };
}

/** Dispatches to the appropriate strategy based on intent kind. */
function findElements(intent: JsonLocatorIntent): Element[] {
  switch (intent.kind) {
    case 'role': {
      const name = decodeTextMatcher(intent.name);
      const all = Array.from(document.querySelectorAll('*'));
      const results: Element[] = [];
      for (const el of all) {
        if (getRole(el) !== intent.role) continue;
        if (name !== undefined) {
          const accessible = getAccessibleName(el);
          if (!matchText(accessible, name, intent.exact ?? true)) continue;
        }
        results.push(el);
      }
      return results;
    }

    case 'testid': {
      const attrs = intent.attribute ? [intent.attribute] : undefined;
      return findByTestId(intent.value, attrs);
    }

    case 'label': {
      const text = decodeTextMatcher(intent.text);
      if (text === undefined) return [];
      return findByLabel(text, intent.exact ?? true);
    }

    case 'placeholder': {
      const text = decodeTextMatcher(intent.text);
      if (text === undefined) return [];
      return findByPlaceholder(text, intent.exact ?? true);
    }

    case 'text': {
      const text = decodeTextMatcher(intent.text);
      if (text === undefined) return [];
      const all = Array.from(document.querySelectorAll('*'));
      const results: Element[] = [];
      for (const el of all) {
        // Skip non-leaf elements to avoid matching container text
        if (el.childElementCount > 0) continue;
        const content = el.textContent ?? '';
        if (matchText(content, text, intent.exact ?? true, intent.normalize ?? true)) {
          results.push(el);
        }
      }
      return results;
    }

    case 'css':
      return queryCss(intent.selector);

    case 'xpath':
      return queryXpath(intent.expression);

    case 'relative': {
      // Resolve anchor first, then apply relation
      const anchorElements = findElements(intent.anchor);
      if (anchorElements.length !== 1) return []; // anchor not uniquely resolved
      const anchor = anchorElements[0];
      if (!anchor) return [];
      return resolveRelative(anchor, intent.relation, intent.targetRole);
    }

    default:
      return [];
  }
}

/** Decodes a JSON text matcher (string or JsonRegex) back to string | RegExp. */
function decodeTextMatcher(
  matcher: string | { __isRegExp: true; pattern: string; flags: string } | undefined,
): string | RegExp | undefined {
  if (matcher === undefined) return undefined;
  if (typeof matcher === 'string') return matcher;
  return new RegExp(matcher.pattern, matcher.flags);
}

/** Checks actionable state of the element currently in the slot. */
function checkActionableStateSlot(): ActionableState {
  if (!resolvedSlot) {
    return { visible: false, enabled: false, stable: false, receivesEvents: false, attached: false };
  }
  return checkActionableState(resolvedSlot);
}

/** Checks hit-target for the element currently in the slot. */
function checkHitTargetSlot(): HitTargetCheckResult {
  if (!resolvedSlot) {
    return { kind: 'outside_viewport', coordinates: { x: 0, y: 0 } };
  }
  return checkHitTarget(resolvedSlot);
}

/** Clears the internal slot after element retrieval. */
function clearSlot(): void {
  resolvedSlot = null;
}

/** Returns the element in the slot (used by callHandle for CDP objectId capture). */
function getSlotElement(): Element | null {
  return resolvedSlot;
}

const api = {
  resolveCandidate,
  checkActionableState: checkActionableStateSlot,
  checkHitTarget: checkHitTargetSlot,
  clearSlot,
  getSlotElement,
  // Internal helpers exported for test access
  isBoundingRectStable,
  isAttached,
  findByNameAttribute,
};

// Register on window.__yantra
(window as Window & typeof globalThis & { __yantra: typeof api }).__yantra = api;
