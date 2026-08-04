/**
 * Field-name → element-ref resolution for `browser_form_fill`.
 *
 * `browser_fill` addresses elements by opaque ref, which works because the model
 * has just seen a (capped, 30-element) observation containing it. A multi-field
 * form tool cannot rely on that: the fields it must reach are frequently outside
 * the model-visible cap, and the ones revealed *by* an earlier step —
 * autocomplete options, calendar cells — did not exist when the model last
 * looked. So this resolver matches human-meaningful names against a fresh,
 * uncapped observation, and accepts a literal `eNN` when the model does have one.
 *
 * Matching is tiered — exact, then prefix, then substring — and stops at the
 * first tier that matches anything. A tier with more than one hit is an
 * **error**, never a guess: on a real search form "Check-in" and "Check-out"
 * share a prefix, and silently picking one would fill the wrong date and look
 * like success.
 */

import type { AgentBrowserObservation, AgentInteractable } from '@yantra/core';

import type { DomainFailure } from '../../../runtime/middleware.js';

/** How many candidate names an error lists back to the model. */
const MAX_SUGGESTIONS = 8;

/** A literal opaque ref, as minted by `observe()`. */
const REF_PATTERN = /^e[0-9]+$/;

/**
 * Resolves one field string against an observation.
 *
 * @param field - An `eNN` ref or a human-readable field name.
 * @param observation - A **fresh, uncapped** observation of the live page.
 * @returns The matched interactable, or a typed, actionable failure.
 */
export function resolveFormField(
  field: string,
  observation: AgentBrowserObservation,
): AgentInteractable | DomainFailure {
  const query = field.trim();
  if (query.length === 0) {
    return {
      ok: false,
      errorCode: 'FORM_FIELD_NOT_FOUND',
      message: 'A field name or ref is required.',
      retryable: true,
    };
  }

  if (REF_PATTERN.test(query)) {
    const byRef = observation.interactables.find((entry) => entry.ref === query);
    if (byRef !== undefined) return byRef;
    return {
      ok: false,
      errorCode: 'STALE_ELEMENT_REF',
      message:
        `Element ref "${query}" is stale or unknown. Call browser_observe again, or ` +
        'address the field by its visible name instead.',
      retryable: true,
    };
  }

  const needle = query.toLowerCase();
  const named = observation.interactables.filter((entry) => entry.name.trim().length > 0);
  const tiers: readonly AgentInteractable[][] = [
    named.filter((entry) => entry.name.trim().toLowerCase() === needle),
    named.filter((entry) => entry.name.trim().toLowerCase().startsWith(needle)),
    named.filter((entry) => entry.name.trim().toLowerCase().includes(needle)),
  ];

  const winning = tiers.find((tier) => tier.length > 0);
  if (winning === undefined) {
    return {
      ok: false,
      errorCode: 'FORM_FIELD_NOT_FOUND',
      message:
        `No field named "${query}" is present on the page. Fields available: ` +
        `${describe(named)}. Re-observe if the page has changed.`,
      retryable: true,
    };
  }
  if (winning.length > 1) {
    return {
      ok: false,
      errorCode: 'FORM_FIELD_AMBIGUOUS',
      message:
        `"${query}" matches ${winning.length} fields: ${describe(winning)}. Use a longer, ` +
        'more specific name, or an eNN ref from browser_observe.',
      retryable: true,
    };
  }
  return winning[0]!;
}

/** Renders up to {@link MAX_SUGGESTIONS} candidate names for an error message. */
function describe(candidates: readonly AgentInteractable[]): string {
  if (candidates.length === 0) return '(none)';
  const names = candidates.slice(0, MAX_SUGGESTIONS).map((entry) => `"${entry.name.trim()}"`);
  const extra = candidates.length - names.length;
  return extra > 0 ? `${names.join(', ')} (+${extra} more)` : names.join(', ');
}
