/// <reference lib="dom" />

/**
 * Actionable-state checker.
 *
 * Ports the actionable-state checks from Playwright's injected library (Apache-2.0).
 * Source attribution: playwright-core/src/server/injected/injectedScript.ts
 * License: Apache-2.0 (https://www.apache.org/licenses/LICENSE-2.0)
 *
 * An element is "actionable" when ALL four conditions are met:
 *   visible: bounding rect > 0 AND not display:none/visibility:hidden/opacity:0
 *   enabled: no [disabled] attribute, no aria-disabled="true"
 *   stable:  bounding rect unchanged for ≥ 100ms (checked via two snapshots by the auto-wait loop)
 *   receivesEvents: elementFromPoint(cx,cy) is the element or a descendant
 */

/** @see types.ts ActionableState */
export interface ActionableState {
  readonly visible: boolean;
  readonly enabled: boolean;
  readonly stable: boolean;
  readonly receivesEvents: boolean;
  readonly attached: boolean;
}

/**
 * Checks whether the given element is actionable.
 *
 * For `stable`, this method takes a single snapshot. The auto-wait loop calls
 * this twice with 100ms between calls and compares `stable: true` from both.
 * In this single-call form, `stable` always returns `true` — the loop handles
 * temporal stability.
 *
 * @param el - Element to check
 * @returns Current actionable state
 */
export function checkActionableState(el: Element): ActionableState {
  return {
    visible: isVisible(el),
    enabled: isEnabled(el),
    stable: true,   // temporal stability is determined by the auto-wait loop externally
    receivesEvents: receivesPointerEvents(el),
    attached: isAttached(el),
  };
}

/** Returns whether the element has a non-zero visible bounding box. */
export function isVisible(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;

  const style = window.getComputedStyle(el);
  if (style.visibility === 'hidden') return false;
  if (style.display === 'none') return false;
  if (parseFloat(style.opacity) === 0) return false;

  return true;
}

/** Returns whether the element is enabled (not disabled). */
export function isEnabled(el: Element): boolean {
  // aria-disabled="true" disables semantically
  if (el.getAttribute('aria-disabled') === 'true') return false;

  // Standard disabled attribute
  if ('disabled' in el && (el as HTMLButtonElement | HTMLInputElement).disabled) return false;

  return true;
}

/** Returns whether pointer events would reach this element (not intercepted). */
function receivesPointerEvents(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;

  if (
    cx < 0 ||
    cy < 0 ||
    cx > (window.innerWidth || document.documentElement.clientWidth) ||
    cy > (window.innerHeight || document.documentElement.clientHeight)
  ) {
    return false;
  }

  const hitEl = document.elementFromPoint(cx, cy);
  return hitEl === el || el.contains(hitEl);
}

/** Returns whether the element is still attached to the live document. */
export function isAttached(el: Element): boolean {
  return document.contains(el);
}

/**
 * Checks stability by comparing two bounding-rect snapshots.
 * The auto-wait loop calls this helper after a 100ms pause.
 *
 * @param rect1 - First bounding rect snapshot
 * @param rect2 - Second bounding rect snapshot (taken 100ms later)
 * @returns true if position and size are identical in both snapshots
 */
export function isBoundingRectStable(rect1: DOMRect, rect2: DOMRect): boolean {
  return (
    rect1.top === rect2.top &&
    rect1.left === rect2.left &&
    rect1.width === rect2.width &&
    rect1.height === rect2.height
  );
}
