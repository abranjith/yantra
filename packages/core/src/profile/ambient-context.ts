/**
 * The ambient-context chokepoint — the second (and only other) code path that
 * turns a user's preferences into text bound for an LLM prompt.
 *
 * It exists because the personalization context is *optional* and absent on
 * `do`/`research`, which is precisely how a run reached the model with no
 * location and the model inferred one from the timezone. A user's location is
 * an ambient fact about the run, so it belongs in the ambient block — but it is
 * also personal data, so it is gated by an explicit grant and carries the same
 * three structural guarantees as {@link buildPersonalizationContext}:
 *
 *  1. **Preferences only, never history.** Both resolvers accept
 *     {@link EffectivePreferences} and nothing else. There is no overload,
 *     field, or branch that reads a `history` row.
 *  2. **Approved only.** A value contributes only when its row's `approved`
 *     flag is true — `profile.yaml` and explicit `prefs set` values are
 *     approved by definition; machine-`learned` signals require an explicit
 *     `yantra prefs approve`.
 *  3. **Sanitized + bounded + branded.** {@link resolveUserLocation} passes its
 *     output through the single `sanitize()` chokepoint, hard-caps it at
 *     {@link MAX_LOCATION_CHARS}, and returns it with the {@link Sanitized}
 *     brand — the only type the ambient block's location slot accepts.
 */

import { brandSanitized, type Sanitized } from '../sanitizer/brand.js';
import { sanitize } from '../sanitizer/index.js';

import type { EffectivePreferences } from './effective-preferences.js';

/** Hard cap on the resolved user location (chars). */
export const MAX_LOCATION_CHARS = 120;

/**
 * The user's grants over sensitive ambient facts.
 *
 * Declared as an interface even though it currently holds a single member: it
 * is the extension point for future sensitive facts, so adding one is a
 * one-line change rather than a schema reshape. Host-environment facts (date,
 * timezone, locale) are deliberately absent — they are not personal data and
 * always render.
 */
export interface AmbientGrants {
  /**
   * Whether the engine may state the user's location (composed from
   * `locale.city` / `locale.region`) to the model.
   */
  readonly location: boolean;
}

/**
 * Resolves the user's ambient grants from their effective preferences.
 *
 * A grant defaults to `true` when its row is absent or unapproved — the same
 * behavior-preserving default the profile schema carries. Denial is an explicit
 * act, so only an explicit, approved `false` withholds the fact.
 *
 * @param prefs - The merged effective preferences (from `PreferenceStore`).
 */
export function resolveAmbientGrants(prefs: EffectivePreferences): AmbientGrants {
  return { location: approvedBoolean(prefs, 'context.location') !== false };
}

/**
 * Resolves the user's location for the ambient block, or `null` when it is not
 * available.
 *
 * `null` covers three cases that are deliberately indistinguishable downstream:
 * the grant was denied, no value is configured, or the stored rows are not
 * approved. The model's correct behavior is identical in all three (it does not
 * have the fact and must not derive one), and distinguishing them would leak
 * that a withheld value exists while giving the model nothing actionable. The
 * *user-facing* remedy does distinguish them — see the location gate.
 *
 * @param prefs - The merged effective preferences (from `PreferenceStore`).
 * @returns The sanitized, capped, branded location, or `null`.
 */
export function resolveUserLocation(prefs: EffectivePreferences): Sanitized<string> | null {
  if (!resolveAmbientGrants(prefs).location) {
    return null;
  }

  const parts = [approvedText(prefs, 'locale.city'), approvedText(prefs, 'locale.region')].filter(
    (part): part is string => part !== undefined,
  );
  if (parts.length === 0) {
    return null;
  }

  // Single sanitizer chokepoint — strips any credential/PII shape that slipped
  // into a hand-edited pref value before it can reach a prompt.
  const sanitized = sanitize(parts.join(', '), 'public').text.trim();
  if (sanitized.length === 0) {
    return null;
  }
  return brandSanitized(sanitized.slice(0, MAX_LOCATION_CHARS));
}

/** Returns an approved boolean value, or `undefined` when absent/unapproved. */
function approvedBoolean(prefs: EffectivePreferences, key: string): boolean | undefined {
  const entry = prefs.get(key);
  if (!entry?.approved || typeof entry.value !== 'boolean') {
    return undefined;
  }
  return entry.value;
}

/** Returns an approved, trimmed, non-blank string value, or `undefined`. */
function approvedText(prefs: EffectivePreferences, key: string): string | undefined {
  const entry = prefs.get(key);
  if (!entry?.approved || typeof entry.value !== 'string') {
    return undefined;
  }
  const trimmed = entry.value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
