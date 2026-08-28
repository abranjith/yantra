/**
 * Field-name → element-ref resolution for the unified browser fill tools.
 *
 * A current opaque ref works when the model has just seen a capped observation
 * containing it. A multi-field form tool cannot rely on that: the fields it
 * must reach are frequently outside the model-visible cap, and the ones
 * revealed *by* an earlier step — autocomplete options, calendar cells — did not
 * exist when the model last looked. So this resolver matches human-meaningful
 * names against a fresh, uncapped observation, and accepts a literal `eNN` when
 * the model does have one.
 *
 * The matching itself lives in `@yantra/core`'s shared resolver, alongside the
 * fill engine's re-acquisition and deterministic replay, because four copies of
 * this logic had already drifted apart. This module owns only what is specific
 * to the tool seam: turning a `Resolution` into the tool's typed failures and
 * their model-facing wording.
 */

import {
  resolveInteractable,
  type AgentBrowserObservation,
  type AgentInteractable,
} from '@yantra/core';

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

  const resolved = resolveInteractable(query, observation.interactables);
  if (resolved.kind === 'match') return resolved.entry;

  // A ref the model supplied but the page no longer has is a different problem
  // from a name nobody can find, and it has a different remedy.
  if (resolved.kind === 'none' && REF_PATTERN.test(query)) {
    return {
      ok: false,
      errorCode: 'STALE_ELEMENT_REF',
      message:
        `Element ref "${query}" is stale or unknown. Call browser_observe again, or ` +
        'address the field by its visible name instead.',
      retryable: true,
    };
  }

  if (resolved.kind === 'none') {
    return {
      ok: false,
      errorCode: 'FORM_FIELD_NOT_FOUND',
      message:
        `No field named "${query}" is present on the page. Fields available: ` +
        `${describe(resolved.offered)}. Re-observe if the page has changed.`,
      retryable: true,
    };
  }

  return {
    ok: false,
    errorCode: 'FORM_FIELD_AMBIGUOUS',
    message:
      `"${query}" matches ${resolved.offered.length} different fields: ` +
      `${describe(resolved.offered)}. Re-issue this call with one of those names in full, ` +
      'or with an eNN ref from browser_observe.',
    retryable: true,
    details: { offered: resolved.offered.slice(0, MAX_SUGGESTIONS).map((e) => e.name.trim()) },
  };
}

/** Renders up to {@link MAX_SUGGESTIONS} candidate names for an error message. */
function describe(candidates: readonly AgentInteractable[]): string {
  if (candidates.length === 0) return '(none)';
  const names = candidates.slice(0, MAX_SUGGESTIONS).map((entry) => `"${entry.name.trim()}"`);
  const extra = candidates.length - names.length;
  return extra > 0 ? `${names.join(', ')} (+${extra} more)` : names.join(', ');
}
