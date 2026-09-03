/**
 * The one protected-action lexicon.
 *
 * A name matching this pattern describes an action a person, not an engine,
 * decides to take: money moves, an order is placed, a form is committed. It
 * gates two different things and must stay a single object so they can never
 * drift apart:
 *
 * - `browser_click`'s confirmation gateway, which routes a matching click
 *   through the user's consent machinery (`packages/agent`).
 * - The obstruction protocol's auto-clearance veto, which refuses to press a
 *   matching control however close-shaped its label also looks
 *   (`packages/core/src/browser/obstruction.ts`).
 *
 * It lives in `core` because the second caller runs there and `core` must never
 * import `@yantra/agent`; `browser-common.ts` re-exports this exact object so
 * every existing agent-side import site is unchanged.
 */
export const PROTECTED_ACTION_RE =
  /\b(?:buy|pay|purchase|book|order|submit|confirm|place order)\b/i;
