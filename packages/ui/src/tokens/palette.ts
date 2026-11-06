/**
 * Drshya primitive tier: the raw fog ramp and signal values.
 *
 * Primitives are emitted as plain custom properties (`--drshya-<name>`) and
 * never become Tailwind utilities (spec S1): components use the semantic tier.
 * Values come from `.spec-lite/ui_brainstorm.md` §"Color: fog and signal",
 * with FEAT-061 deviations D1 (light Ion fill 0.54), D2 (separate text inks for
 * Jade and Amber) and D4 (light signal chroma reduced into the sRGB gamut).
 */

import { oklch, type Oklch } from './color-math.js';

/** The two themes every token resolves in. */
export type Theme = 'light' | 'dark';

export const THEMES: readonly Theme[] = ['light', 'dark'];

/** A primitive color with its value in each theme. */
export interface PrimitiveToken<Name extends string = string> {
  readonly name: Name;
  readonly light: Oklch;
  readonly dark: Oklch;
}

/** A theme-independent primitive (the fog steps). */
function fixed<Name extends string>(
  name: Name,
  l: number,
  c: number,
  h: number,
): PrimitiveToken<Name> {
  const value = oklch(l, c, h);
  return { name, light: value, dark: value };
}

function themed<Name extends string>(name: Name, light: Oklch, dark: Oklch): PrimitiveToken<Name> {
  return { name, light, dark };
}

/**
 * Every primitive, in emission order. The fog ramp is thirteen cool neutrals
 * at hue 255; each signal has a graphic value and, where the light graphic
 * fails 4.5:1 as text, a darker `-ink` value (D2).
 */
export const PRIMITIVES = [
  fixed('fog-00', 0.994, 0.002, 255),
  fixed('fog-05', 0.975, 0.004, 255),
  fixed('fog-10', 0.952, 0.005, 255),
  fixed('fog-20', 0.915, 0.006, 255),
  fixed('fog-30', 0.862, 0.007, 255),
  fixed('fog-40', 0.76, 0.009, 255),
  fixed('fog-50', 0.64, 0.01, 255),
  fixed('fog-60', 0.53, 0.011, 255),
  fixed('fog-70', 0.42, 0.011, 255),
  fixed('fog-80', 0.31, 0.01, 255),
  fixed('fog-90', 0.22, 0.009, 255),
  fixed('fog-95', 0.165, 0.008, 255),
  fixed('fog-99', 0.125, 0.007, 255),
  // Ion: two fills (deep with white text in light, bright with near-black
  // text in dark) and an ink for links and accent text.
  themed('ion-fill', oklch(0.54, 0.097, 218), oklch(0.8, 0.14, 218)),
  themed('ion-on-fill', oklch(1, 0, 0), oklch(0.18, 0.03, 230)),
  themed('ion-ink', oklch(0.5, 0.089, 218), oklch(0.82, 0.12, 218)),
  themed('jade', oklch(0.55, 0.12, 162), oklch(0.76, 0.14, 162)),
  themed('jade-ink', oklch(0.51, 0.111, 162), oklch(0.76, 0.14, 162)),
  themed('amber', oklch(0.62, 0.139, 65), oklch(0.8, 0.14, 65)),
  themed('amber-ink', oklch(0.54, 0.121, 65), oklch(0.8, 0.14, 65)),
  themed('crimson', oklch(0.55, 0.2, 25), oklch(0.7, 0.18, 25)),
  themed('rani', oklch(0.55, 0.22, 352), oklch(0.72, 0.2, 352)),
] as const satisfies readonly PrimitiveToken[];

/** The name of a shipped primitive. */
export type PrimitiveName = (typeof PRIMITIVES)[number]['name'];
