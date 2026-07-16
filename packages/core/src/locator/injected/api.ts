/// <reference lib="dom" />

/**
 * Type-only declarations for the injected bundle's public API.
 * Shared between Node side (import type) and the bundle entry (runtime).
 * No runtime imports — this is a pure .d.ts-style module.
 */

import type {
  ActionableState,
  HitTargetCheckResult,
  JsonLocatorIntent,
  CandidateResolution,
} from '../types.js';

export interface InjectedAPI {
  /**
   * Resolves a single candidate intent against the current document.
   * Returns count of matching elements. When count === 1, the found element
   * is stored in the internal slot and a slotKey is returned for retrieval.
   *
   * @param encodedIntent - JSON-safe locator intent
   * @param strict - when true, count > 1 is treated as ambiguous (returned as-is)
   */
  resolveCandidate(encodedIntent: JsonLocatorIntent, strict: boolean): CandidateResolution;

  /**
   * Checks actionable state for the element currently in the resolved slot.
   * Must be called immediately after a successful resolveCandidate.
   */
  checkActionableState(): ActionableState;

  /**
   * Checks whether a click at the element's center would land on the element
   * or a descendant (not intercepted by overlay/modal/banner).
   */
  checkHitTarget(): HitTargetCheckResult;

  /**
   * Clears the internal element slot. Called by the resolver after retrieving
   * the element handle via callHandle.
   */
  clearSlot(): void;

  /**
   * Returns the element currently in the internal slot.
   * Used by callHandle — the return value is captured as a CDP RemoteObject.
   */
  getSlotElement(): Element | null;

  /** Returns the current slot's viewport rect for stability checks. */
  getBoundingRect(): { top: number; left: number; width: number; height: number };
}
