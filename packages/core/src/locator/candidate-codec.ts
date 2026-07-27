/**
 * Engine intent → persisted workflow candidate.
 *
 * The locator engine's `LocatorIntent` is richer than what a workflow file can
 * hold: it has relative anchors, free-text matching, and the full ARIA role
 * vocabulary. `_locators` entries are a deliberately narrower, reviewable
 * subset. This module is the single conversion point between the two, so a
 * recorder never has to guess which of its candidates are persistable.
 *
 * Kinds that cannot round-trip (`relative`, `text`) and roles outside the
 * protocol's `RoleEnum` are dropped rather than coerced: a candidate that
 * cannot be expressed faithfully must not be written as an approximation that
 * silently resolves to the wrong element at replay.
 */

import { RoleEnum, type LocatorCandidate } from '@yantra/protocol';

import type { JsonLocatorIntent, JsonRegex } from './types.js';

const PERSISTABLE_ROLES = new Set<string>(RoleEnum.options);

function isJsonRegex(value: string | JsonRegex | undefined): value is JsonRegex {
  return typeof value === 'object' && value !== null && value.__isRegExp === true;
}

/**
 * Converts one engine intent to its persisted form.
 *
 * @param intent - A JSON-safe intent produced by the injected ranker.
 * @returns The workflow candidate, or null when the intent has no faithful
 *   persisted representation.
 */
export function intentToWorkflowCandidate(intent: JsonLocatorIntent): LocatorCandidate | null {
  switch (intent.kind) {
    case 'role': {
      if (!PERSISTABLE_ROLES.has(intent.role)) return null;
      // Membership was just verified against RoleEnum; the cast only narrows
      // the engine's wider AriaRole literal to the persisted subset.
      const role = intent.role as Extract<LocatorCandidate, { kind: 'role' }>['role'];
      // An absent name means "no name constraint"; the schema's only spelling
      // for that is the empty string, which the replay translator reads back as
      // unconstrained.
      if (intent.name === undefined) return { kind: 'role', role, name: '' };
      if (isJsonRegex(intent.name)) {
        return {
          kind: 'role',
          role,
          name: { pattern: intent.name.pattern, flags: intent.name.flags },
        };
      }
      return { kind: 'role', role, name: intent.name };
    }
    case 'testid':
      return intent.value.length > 0 ? { kind: 'testid', value: intent.value } : null;
    case 'label':
      return typeof intent.text === 'string' && intent.text.trim().length > 0
        ? { kind: 'label', value: intent.text }
        : null;
    case 'placeholder':
      return typeof intent.text === 'string' && intent.text.trim().length > 0
        ? { kind: 'placeholder', value: intent.text }
        : null;
    case 'css':
      return intent.selector.trim().length > 0 ? { kind: 'css', value: intent.selector } : null;
    case 'xpath':
      return intent.expression.trim().length > 0
        ? { kind: 'xpath', value: intent.expression }
        : null;
    // `relative` anchors and `text` matchers have no _locators representation.
    case 'relative':
    case 'text':
      return null;
  }
}

/**
 * Converts a ranked intent list into the persistable candidate chain, keeping
 * rank order (best first) and dropping what cannot be expressed.
 *
 * @param intents - Ranked intents from the injected ranker, best first.
 * @returns The ordered persistable chain — possibly empty.
 */
export function intentsToWorkflowCandidates(
  intents: readonly JsonLocatorIntent[],
): LocatorCandidate[] {
  const candidates: LocatorCandidate[] = [];
  for (const intent of intents) {
    const candidate = intentToWorkflowCandidate(intent);
    if (candidate !== null) candidates.push(candidate);
  }
  return candidates;
}
