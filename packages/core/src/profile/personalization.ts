/**
 * The personalization chokepoint — one of exactly two code paths that turn a
 * user's preferences into text bound for an LLM prompt. The other is
 * `ambient-context.ts`, which resolves the user's granted location for the
 * ambient block. The two exist because they feed different prompt sections and
 * obey different gating (personalization is a master switch; location is a
 * per-fact user grant), but they share one rule set: the three privacy
 * properties below hold *structurally* in both, and any future preference→prompt
 * path must be added here or there rather than opened as a third.
 *
 * Three privacy properties are guaranteed *structurally* here (plan §6):
 *
 *  1. **Preferences only, never history.** {@link buildPersonalizationContext}
 *     accepts {@link EffectivePreferences} and nothing else. There is no
 *     overload, field, or branch that reads a `history` row — raw prior-query
 *     text simply has no way in. (TASK-005 backs this with a property test and
 *     an import-graph guard.)
 *  2. **Approved only.** A preference contributes to the context only when its
 *     `approved` flag is true — `profile.yaml` and explicit `prefs set` values
 *     are approved by definition; machine-`learned` signals require an explicit
 *     `yantra prefs approve`.
 *  3. **Sanitized + bounded + branded.** The composed text passes through the
 *     single `sanitize()` chokepoint (public profile, so credential/PII shapes
 *     are stripped), is hard-capped at {@link MAX_CONTEXT_CHARS} at a line
 *     boundary, and is returned with the {@link Sanitized} brand — the only type
 *     `SynthesisOptions.personalization` accepts.
 */

import { err, ok, type Result } from '@yantra/protocol';

import { brandSanitized, type Sanitized } from '../sanitizer/brand.js';
import { sanitize } from '../sanitizer/index.js';

import type { EffectivePreferences } from './effective-preferences.js';

/** Hard cap on the personalization context length (chars). */
export const MAX_CONTEXT_CHARS = 400;

/** A bounded, sanitized personalization context ready for prompt injection. */
export type PersonalizationContext = Sanitized<string>;

/** Failure building the context (returned, never thrown). */
export class PersonalizationError extends Error {
  public override readonly name = 'PersonalizationError';
}

/**
 * Builds the sanitized personalization context from approved preferences, or
 * `null` when personalization is disabled or nothing approved is available.
 *
 * The input type is {@link EffectivePreferences} — preferences only. This is the
 * structural core of the "raw history never reaches the LLM" guarantee.
 *
 * @param prefs - The merged effective preferences (from `PreferenceStore`).
 * @returns The branded context, `null` when nothing to inject, or an error.
 */
export function buildPersonalizationContext(
  prefs: EffectivePreferences,
): Result<PersonalizationContext | null, PersonalizationError> {
  try {
    // Master switch: an explicit, approved `enabled: false` suppresses all context.
    const enabled = prefs.get('personalization.enabled');
    if (enabled?.value === false) {
      return ok(null);
    }

    const lines = composeLines(prefs);
    if (lines.length === 0) {
      return ok(null);
    }

    const joined = capAtLineBoundary(lines, MAX_CONTEXT_CHARS);

    // Single sanitizer chokepoint — strips any credential/PII shape that slipped
    // into a hand-edited pref value before it can reach a prompt.
    const sanitized = sanitize(joined, 'public');
    return ok(brandSanitized(sanitized.text));
  } catch (error) {
    return err(
      new PersonalizationError(
        `failed to build personalization context: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
    );
  }
}

/** Composes declarative context lines from the approved preference values. */
function composeLines(prefs: EffectivePreferences): string[] {
  const lines: string[] = [];

  const units = approvedValue<string>(prefs, 'locale.units');
  if (units !== undefined) {
    lines.push(`Prefers ${units} units.`);
  }

  const region = approvedValue<string | null>(prefs, 'locale.region');
  if (typeof region === 'string' && region.trim().length > 0) {
    lines.push(`Based in ${region.trim()}.`);
  }

  const retailers = approvedStringList(prefs, 'personalization.favorite_retailers');
  if (retailers.length > 0) {
    lines.push(`Favors retailers: ${retailers.join(', ')}.`);
  }

  const interests = approvedStringList(prefs, 'personalization.interests');
  if (interests.length > 0) {
    lines.push(`Interested in: ${interests.join(', ')}.`);
  }

  return lines;
}

/** Returns a preference value only when its row is approved. */
function approvedValue<T>(prefs: EffectivePreferences, key: string): T | undefined {
  const entry = prefs.get(key);
  if (!entry?.approved) {
    return undefined;
  }
  return entry.value as T;
}

/** Returns an approved string-array value, filtered to non-empty strings. */
function approvedStringList(prefs: EffectivePreferences, key: string): string[] {
  const value = approvedValue<unknown>(prefs, key);
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (entry): entry is string => typeof entry === 'string' && entry.trim().length > 0,
  );
}

/**
 * Joins lines with spaces, dropping any line that would push the result past
 * `cap`. Truncation happens at a line boundary so the context is never a
 * dangling fragment.
 */
function capAtLineBoundary(lines: readonly string[], cap: number): string {
  let result = '';
  for (const line of lines) {
    const candidate = result.length === 0 ? line : `${result} ${line}`;
    if (candidate.length > cap) {
      break;
    }
    result = candidate;
  }
  return result;
}
