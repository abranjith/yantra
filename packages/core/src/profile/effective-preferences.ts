/**
 * The merged, read-only view of a user's preferences — the single value both
 * flag-default resolution and the personalization builder consume.
 *
 * Deliberately dependency-free (imports nothing) so the privacy-sensitive
 * personalization builder can import these types without pulling in any
 * `index-db` / history code. This keeps TASK-005's import-graph guard trivially
 * satisfied: an LLM-payload assembler touches only preference *values*, never
 * history rows.
 */

/** Where a preference value originated. */
export type PreferenceSourceKind = 'user' | 'learned';

/** Which layer supplied the winning value. */
export type PreferenceProvenance = 'profile.yaml' | 'index.db';

/** One resolved preference in the merged view. */
export interface EffectivePreference {
  /** Dotted preference key (e.g. `defaults.detail`). */
  readonly key: string;
  /** Decoded value (already JSON-parsed for DB-sourced rows). */
  readonly value: unknown;
  /** Whether the value is user-authored or machine-learned. */
  readonly source: PreferenceSourceKind;
  /**
   * Whether this value may enter the personalization context. `profile.yaml`
   * and explicit `prefs set` values are approved by definition; `learned` rows
   * require an explicit `yantra prefs approve`.
   */
  readonly approved: boolean;
  /** The layer that supplied the winning value. */
  readonly provenance: PreferenceProvenance;
}

/** Merged preferences keyed by dotted key. */
export type EffectivePreferences = ReadonlyMap<string, EffectivePreference>;

/**
 * Resolves a single effective preference value, or a fallback when the key is
 * absent. Used for flag-default resolution (explicit flag > prefs > fallback).
 *
 * @param prefs - The merged view.
 * @param key - Dotted preference key.
 * @param fallback - Value to use when the key is not set.
 */
export function preferenceValue<T>(prefs: EffectivePreferences, key: string, fallback: T): T {
  const entry = prefs.get(key);
  return entry !== undefined ? (entry.value as T) : fallback;
}
