/**
 * Interactable ranking (FEAT-020 TASK-003).
 *
 * Pure Node-side logic (no DOM) that takes the raw scan from
 * `interactable-scan.ts` and produces the capped, protocol-shaped
 * `InteractableDescriptor[]` an observation carries. Kept separate from the
 * in-page scanner so ranking/filtering/capping is unit-testable with plain
 * arrays — no jsdom, no browser.
 */

import type { InteractableDescriptor } from '@yantra/protocol';

import type { RawInteractable } from './interactable-scan.js';

/** Cap on interactables per observation — must match protocol's `MAX_INTERACTABLES`. */
export const MAX_INTERACTABLES = 30;

/**
 * Filters to visible elements, ranks by prominence (top-of-viewport first —
 * reading order is the cheapest reliable proxy for "what a user would notice
 * first"), and caps to {@link MAX_INTERACTABLES}, then maps to the protocol
 * shape (dropping the internal `top`/`visible` ranking fields).
 *
 * @param raw - Every candidate the in-page scanner found.
 * @param cap - Override the cap (tests only); defaults to {@link MAX_INTERACTABLES}.
 */
export function rankInteractables(
  raw: readonly RawInteractable[],
  cap: number = MAX_INTERACTABLES,
): InteractableDescriptor[] {
  return raw
    .filter((entry) => entry.visible)
    .slice()
    .sort((a, b) => a.top - b.top)
    .slice(0, cap)
    .map((entry) => ({
      role: entry.role,
      name: entry.name,
      kind: entry.kind,
      disabled: entry.disabled,
    }));
}
