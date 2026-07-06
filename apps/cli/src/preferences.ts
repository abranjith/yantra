/**
 * CLI-side helpers for the preference system: opening the `PreferenceStore` and
 * building the merged {@link EffectivePreferences} view (profile.yaml ⊕ index).
 *
 * Like the history helpers, these degrade gracefully — a missing index or an
 * unreadable profile yields the yaml/default layer rather than failing a
 * command (the index is an optional cache; flag-default resolution must never
 * break `ask`).
 */

import {
  SqlitePreferenceStore,
  defaultProfile,
  flattenProfile,
  loadProfile,
  openIndexDb,
  type EffectivePreference,
  type EffectivePreferences,
  type Logger,
  type PreferenceStore,
} from '@yantra/core';

/** An open preference store plus a close handle. */
export interface OpenPreferences {
  readonly store: PreferenceStore;
  readonly close: () => void;
}

/**
 * Opens the index and returns a {@link PreferenceStore}, or `null` when the
 * index cannot be opened.
 */
export async function openPreferences(logger?: Logger): Promise<OpenPreferences | null> {
  try {
    const { db } = await openIndexDb(logger ? { logger } : {});
    return {
      store: new SqlitePreferenceStore({ db, ...(logger ? { logger } : {}) }),
      close: () => {
        try {
          db.close();
        } catch {
          // best-effort
        }
      },
    };
  } catch (error) {
    logger?.debug?.(
      { error: error instanceof Error ? error.message : String(error) },
      'preference index unavailable',
    );
    return null;
  }
}

/**
 * Builds the merged effective preferences for read paths (flag defaults,
 * personalization). Best-effort: an invalid profile falls back to defaults, and
 * a missing index yields the yaml layer alone.
 */
export async function loadEffectivePreferences(logger?: Logger): Promise<EffectivePreferences> {
  const loaded = await loadProfile();
  const profile = loaded.isOk ? loaded.value : defaultProfile();
  if (!loaded.isOk) {
    logger?.warn?.({ error: loaded.error }, 'profile.yaml invalid; using defaults');
  }
  const yamlLayer = flattenProfile(profile);

  const handle = await openPreferences(logger);
  if (handle === null) {
    return yamlOnly(yamlLayer);
  }
  try {
    const result = await handle.store.effective(yamlLayer);
    return result.isOk ? result.value : yamlOnly(yamlLayer);
  } finally {
    handle.close();
  }
}

/** Builds an effective view from the yaml layer alone (no index available). */
function yamlOnly(yamlLayer: ReadonlyMap<string, unknown>): EffectivePreferences {
  const map = new Map<string, EffectivePreference>();
  for (const [key, value] of yamlLayer) {
    map.set(key, { key, value, source: 'user', approved: true, provenance: 'profile.yaml' });
  }
  return map;
}
