/**
 * Drshya semantic tier: the colors components use.
 *
 * Tailwind v4 `@theme` turns each name into utilities (`bg-surface`,
 * `text-ink-2`, `border-rule`). Each name maps to one primitive per theme;
 * re-pointing the map is how a theme is retuned.
 */

import type { PrimitiveName } from './palette.js';

/** Every semantic color, in emission order. Closed: adding one is a typed change. */
export const SEMANTIC_COLOR_NAMES = [
  'bg',
  'surface',
  'sunken',
  'ink',
  'ink-2',
  'ink-3',
  'rule',
  'rule-strong',
  'field-edge',
  'accent',
  'on-accent',
  'accent-ink',
  'signal-fulfilled',
  'signal-partial',
  'signal-failed',
  'signal-needs-you',
  'signal-fulfilled-ink',
  'signal-partial-ink',
  'signal-failed-ink',
  'signal-needs-you-ink',
  'glass-tint',
  'glass-edge',
  'glass-spec',
] as const;

export type SemanticColor = (typeof SEMANTIC_COLOR_NAMES)[number];

/** The primitive a semantic color resolves to in each theme. */
export interface SemanticMapping {
  readonly light: PrimitiveName;
  readonly dark: PrimitiveName;
}

/**
 * The semantic map (spec §2). `Aborted` deliberately has no signal: it renders
 * in `ink-2` with the ban glyph (spec S4).
 */
export const SEMANTIC_COLORS = {
  bg: { light: 'fog-05', dark: 'fog-99' },
  surface: { light: 'fog-00', dark: 'fog-95' },
  sunken: { light: 'fog-10', dark: 'fog-99' },
  ink: { light: 'fog-95', dark: 'fog-05' },
  'ink-2': { light: 'fog-70', dark: 'fog-40' },
  'ink-3': { light: 'fog-60', dark: 'fog-50' },
  rule: { light: 'fog-20', dark: 'fog-90' },
  'rule-strong': { light: 'fog-30', dark: 'fog-80' },
  'field-edge': { light: 'fog-60', dark: 'fog-50' },
  accent: { light: 'ion-fill', dark: 'ion-fill' },
  'on-accent': { light: 'ion-on-fill', dark: 'ion-on-fill' },
  'accent-ink': { light: 'ion-ink', dark: 'ion-ink' },
  'signal-fulfilled': { light: 'jade', dark: 'jade' },
  'signal-partial': { light: 'amber', dark: 'amber' },
  'signal-failed': { light: 'crimson', dark: 'crimson' },
  'signal-needs-you': { light: 'rani', dark: 'rani' },
  'signal-fulfilled-ink': { light: 'jade-ink', dark: 'jade-ink' },
  'signal-partial-ink': { light: 'amber-ink', dark: 'amber-ink' },
  'signal-failed-ink': { light: 'crimson', dark: 'crimson' },
  'signal-needs-you-ink': { light: 'rani', dark: 'rani' },
  'glass-tint': { light: 'fog-00', dark: 'fog-95' },
  'glass-edge': { light: 'fog-20', dark: 'fog-80' },
  'glass-spec': { light: 'fog-00', dark: 'fog-40' },
} as const satisfies Record<SemanticColor, SemanticMapping>;
