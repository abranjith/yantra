/// <reference lib="dom" />

/**
 * Hit-target interception check.
 *
 * Before any synthesized click, verify elementFromPoint(cx, cy) lands on
 * the intended element or a descendant. If an overlay/modal/banner intercepts,
 * returns the intercepting element's tag and accessible name.
 *
 * Per brainstorm §6.4: "highest-ROI trick Playwright has over naive click-then-hope".
 *
 * A descendant of the target element counts as OK — e.g. a <span> inside a <button>
 * will be what elementFromPoint returns, and that's correct behaviour.
 */

import { getAccessibleName } from './role.js';

/** @see types.ts HitTargetCheckResult */
export type HitTargetCheckResult =
  | { readonly kind: 'ok'; readonly coordinates: { readonly x: number; readonly y: number } }
  | {
      readonly kind: 'intercepted';
      readonly interceptor: {
        readonly tagName: string;
        readonly accessibleName?: string;
        readonly testid?: string;
      };
      readonly coordinates: { readonly x: number; readonly y: number };
    }
  | {
      readonly kind: 'outside_viewport';
      readonly coordinates: { readonly x: number; readonly y: number };
    };

/**
 * Checks whether a click at the center of `el` would land on `el` or a descendant.
 *
 * @param el - The element that should receive the click
 * @returns Hit-target check result
 */
export function checkHitTarget(el: Element): HitTargetCheckResult {
  const rect = el.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const coords = { x: cx, y: cy };

  // Outside viewport
  if (
    cx < 0 ||
    cy < 0 ||
    cx > (window.innerWidth || document.documentElement.clientWidth) ||
    cy > (window.innerHeight || document.documentElement.clientHeight)
  ) {
    return { kind: 'outside_viewport', coordinates: coords };
  }

  const hitEl = document.elementFromPoint(cx, cy);

  if (hitEl === null) {
    return { kind: 'outside_viewport', coordinates: coords };
  }

  // Target itself or any descendant counts as a hit
  if (hitEl === el || el.contains(hitEl)) {
    return { kind: 'ok', coordinates: coords };
  }

  // Something else is on top — report it
  const accessibleName = getAccessibleName(hitEl) || undefined;
  const testid =
    hitEl.getAttribute('data-testid') ??
    hitEl.getAttribute('data-test-id') ??
    hitEl.getAttribute('data-qa') ??
    undefined;

  return {
    kind: 'intercepted',
    interceptor: {
      tagName: hitEl.tagName.toLowerCase(),
      ...(accessibleName !== undefined ? { accessibleName } : {}),
      ...(testid !== undefined ? { testid } : {}),
    },
    coordinates: coords,
  };
}
