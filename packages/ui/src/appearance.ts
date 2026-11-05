/**
 * The appearance contract (spec S7): which theme and which surface style a
 * subtree renders with, expressed as `data-theme` and `data-surfaces`.
 *
 * This module is a mapping, not a store. FEAT-065 reads the `ui.theme` and
 * `ui.surfaces` preferences and applies them; the gallery applies them from
 * its query string.
 */

/** `system` follows `prefers-color-scheme`. */
export type ThemePreference = 'system' | 'light' | 'dark';

/** `solid` swaps every glass surface for an opaque one. */
export type SurfacesPreference = 'glass' | 'solid';

export interface Appearance {
  readonly theme: ThemePreference;
  readonly surfaces: SurfacesPreference;
}

export const DEFAULT_APPEARANCE: Appearance = { theme: 'system', surfaces: 'glass' };

export const THEME_PREFERENCES: readonly ThemePreference[] = ['system', 'light', 'dark'];
export const SURFACES_PREFERENCES: readonly SurfacesPreference[] = ['glass', 'solid'];

/** The DOM attributes for an appearance, ready to spread onto an element. */
export interface AppearanceAttributes {
  readonly 'data-theme'?: 'light' | 'dark';
  readonly 'data-surfaces': SurfacesPreference;
}

/** Maps an appearance to attributes; `system` omits `data-theme` entirely. */
export function appearanceAttributes(appearance: Appearance): AppearanceAttributes {
  return appearance.theme === 'system'
    ? { 'data-surfaces': appearance.surfaces }
    : { 'data-theme': appearance.theme, 'data-surfaces': appearance.surfaces };
}

/** Sets (or, for `system`, removes) the appearance attributes on an element. */
export function applyAppearance(root: HTMLElement, appearance: Appearance): void {
  const attributes = appearanceAttributes(appearance);
  if (attributes['data-theme'] === undefined) {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', attributes['data-theme']);
  }
  root.setAttribute('data-surfaces', attributes['data-surfaces']);
}

function isThemePreference(value: string | null): value is ThemePreference {
  return THEME_PREFERENCES.some((theme) => theme === value);
}

function isSurfacesPreference(value: string | null): value is SurfacesPreference {
  return SURFACES_PREFERENCES.some((surfaces) => surfaces === value);
}

/**
 * Reads an appearance from untrusted strings (a query string, a stored
 * preference). Anything unrecognized falls back to the default for that field.
 */
export function parseAppearance(theme: string | null, surfaces: string | null): Appearance {
  return {
    theme: isThemePreference(theme) ? theme : DEFAULT_APPEARANCE.theme,
    surfaces: isSurfacesPreference(surfaces) ? surfaces : DEFAULT_APPEARANCE.surfaces,
  };
}
