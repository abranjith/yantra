/**
 * Applies the `ui.theme` and `ui.surfaces` preferences to the page
 * (FEAT-065 TASK-011): `data-theme` (omitted for `system`) and
 * `data-surfaces` on `<html>`, kept current on `prefs.changed`.
 *
 * Values come from `read.profile` — the effective profile, so a default or a
 * hand-edited `profile.yaml` applies too. Anything unrecognized falls back to
 * the default.
 */

import { applyAppearance, DEFAULT_APPEARANCE, parseAppearance, type Appearance } from '@yantra/ui';

/** The RPC slice preferences need. */
export interface PreferencesRpc {
  request<T>(method: string, params?: Record<string, unknown>): Promise<T>;
  subscribe(method: string, params?: Record<string, unknown>): void;
  on(method: string, handler: (params: Record<string, unknown>) => void): () => void;
}

/** Reads the appearance out of a `read.profile` result. */
export function appearanceFromProfile(result: unknown): Appearance {
  const value = (result as { value?: { preferences?: unknown } } | null)?.value;
  const rows = Array.isArray(value?.preferences) ? (value.preferences as unknown[]) : [];
  const find = (key: string): string | null => {
    for (const row of rows) {
      if (row !== null && typeof row === 'object') {
        const record = row as { key?: unknown; value?: unknown };
        if (record.key === key && typeof record.value === 'string') return record.value;
      }
    }
    return null;
  };
  return parseAppearance(find('ui.theme'), find('ui.surfaces'));
}

/** Fetches and applies the appearance once. */
export async function applyPreferences(
  rpc: PreferencesRpc,
  root: HTMLElement,
): Promise<Appearance> {
  let appearance = DEFAULT_APPEARANCE;
  try {
    appearance = appearanceFromProfile(await rpc.request('read.profile'));
  } catch {
    // Keep the current look; the next prefs.changed or reconnect retries.
    return appearance;
  }
  applyAppearance(root, appearance);
  return appearance;
}

/**
 * Applies on every (re)connect (`host.build` arrives on each one) and on every
 * `prefs.changed`. `runs.subscribe` is what delivers `prefs.changed`, so this
 * subscribes too. Returns the stop function.
 */
export function startPreferences(rpc: PreferencesRpc, root: HTMLElement): () => void {
  const apply = (): void => {
    void applyPreferences(rpc, root);
  };
  const offChanged = rpc.on('prefs.changed', apply);
  const offConnect = rpc.on('host.build', apply);
  rpc.subscribe('runs.subscribe');
  apply();
  return () => {
    offChanged();
    offConnect();
  };
}
