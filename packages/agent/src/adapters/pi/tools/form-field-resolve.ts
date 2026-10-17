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
  resolvableNames,
  type AgentBrowserObservation,
  type AgentInteractable,
  type ResolveInteractableOptions,
} from '@yantra/core';

import { renderAgentMessage } from '../../../runtime/messages.js';
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
  options: ResolveInteractableOptions = {},
): AgentInteractable | DomainFailure {
  const query = field.trim();
  if (query.length === 0) {
    return {
      ok: false,
      errorCode: 'FORM_FIELD_NOT_FOUND',
      message: renderAgentMessage('tool', 'FORM_FIELD_NOT_FOUND', 'no-match', {
        query: '',
        candidates: '(none)',
      }),
      retryable: true,
    };
  }

  const resolved = resolveInteractable(query, observation.interactables, options);
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
    const fields = observation.interactables
      .filter((entry) =>
        ['textbox', 'searchbox', 'combobox', 'listbox', 'checkbox', 'radio'].includes(entry.role),
      )
      .map((entry, index) => ({ entry, index, score: overlap(query, resolvableNames(entry)) }))
      .sort(
        (a, b) =>
          Number(a.entry.disabled === true) - Number(b.entry.disabled === true) ||
          b.score - a.score ||
          a.index - b.index,
      )
      .map(({ entry }) => entry);
    return {
      ok: false,
      errorCode: 'FORM_FIELD_NOT_FOUND',
      message: renderAgentMessage('tool', 'FORM_FIELD_NOT_FOUND', 'no-match', {
        query: query.slice(0, 120),
        candidates: describe(fields),
      }),
      retryable: true,
      details: {
        candidates: fields.slice(0, MAX_SUGGESTIONS).map(candidateDetails),
        remaining: Math.max(0, fields.length - MAX_SUGGESTIONS),
      },
    };
  }

  return {
    ok: false,
    errorCode: 'FORM_FIELD_AMBIGUOUS',
    message: renderAgentMessage('tool', 'FORM_FIELD_AMBIGUOUS', 'same-tier', {
      query: query.slice(0, 120),
      candidates: describe(resolved.offered),
    }),
    retryable: true,
    details: {
      offered: resolved.offered.slice(0, MAX_SUGGESTIONS).map((e) => e.name.trim()),
      candidates: resolved.offered.slice(0, MAX_SUGGESTIONS).map(candidateDetails),
    },
  };
}

/** Renders up to {@link MAX_SUGGESTIONS} candidate names for an error message. */
function describe(candidates: readonly AgentInteractable[]): string {
  if (candidates.length === 0) return '(none)';
  const names = candidates.slice(0, MAX_SUGGESTIONS).map((entry) => {
    const label = entry.field?.label ?? entry.name.trim();
    const section = entry.field?.section ?? entry.group;
    const context = section
      ? `, section "${section.slice(0, 24)}"; use "${section.slice(0, 24)} ${label.slice(0, 40)}"`
      : '';
    const hint = entry.field?.hint;
    const name = label
      ? `"${label.slice(0, 40)}"`
      : `(${['no label', hint?.html_name ? `developer hint name "${hint.html_name}"` : '', hint?.html_id ? `developer hint id "${hint.html_id}"` : ''].filter(Boolean).join('; ')})`;
    return `${entry.ref} ${entry.role} ${name}${entry.field ? ` (${entry.field.origin}${context})` : context}`;
  });
  const bounded: string[] = [];
  for (const name of names) {
    if (Buffer.byteLength([...bounded, name].join(', '), 'utf8') > 3000) break;
    bounded.push(name);
  }
  const extra = candidates.length - bounded.length;
  return extra > 0 ? `${bounded.join(', ')} (+${extra} more)` : bounded.join(', ');
}

/** Token overlap, with character pairs supporting a misspelled single token. */
function overlap(query: string, names: readonly string[]): number {
  const tokens = query.toLowerCase().split(/\W+/u).filter(Boolean);
  const pairs = (text: string): Set<string> =>
    new Set(Array.from({ length: Math.max(0, text.length - 1) }, (_, i) => text.slice(i, i + 2)));
  const wanted = pairs(query.toLowerCase());
  return Math.max(
    0,
    ...names.map((name) => {
      const lower = name.toLowerCase();
      const actual = pairs(lower);
      const shared = [...wanted].filter((pair) => actual.has(pair)).length;
      return (
        tokens.filter((token) => lower.split(/\W+/u).includes(token)).length * 10 +
        shared / Math.max(1, wanted.size + actual.size)
      );
    }),
  );
}

function candidateDetails(entry: AgentInteractable): Record<string, unknown> {
  return {
    ref: entry.ref,
    name: entry.name.trim(),
    role: entry.role,
    group: entry.group ?? null,
    ...(entry.field ? { field: entry.field } : {}),
  };
}
