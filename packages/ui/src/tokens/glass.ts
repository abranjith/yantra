/**
 * Glass, legible by construction (spec S3).
 *
 * Glass is a translucent tint over an unknown, moving backdrop. The backdrop
 * can be any color in the sRGB cube, and relative luminance rises
 * monotonically in each channel, so pure black and pure white are its worst
 * cases; blur and `saturate()` keep colors inside the cube. The noise texture
 * shifts the composite toward black or white by at most its opacity.
 *
 * The scrim floor is the smallest tint opacity at which every glass text token
 * reaches 4.5:1 over both extremes, with noise. The shipped tint is
 * `max(recipe, floor)`: computed, never hand-set.
 */

import { BLACK, WHITE, compositeOver, contrastRatio, type Rgb } from './color-math.js';
import type { Theme } from './palette.js';
import type { SemanticColor } from './semantic.js';

export interface GlassSpec {
  /** The brainstorm's tint opacity per theme. */
  readonly recipeAlpha: Readonly<Record<Theme, number>>;
  /** The noise texture's maximum opacity. */
  readonly noiseAlpha: number;
  /** Backdrop blur in CSS pixels. */
  readonly blurPx: number;
  /** Backdrop saturation multiplier. */
  readonly saturate: number;
}

export const GLASS_SPEC: GlassSpec = {
  recipeAlpha: { light: 0.66, dark: 0.72 },
  noiseAlpha: 0.03,
  blurPx: 20,
  saturate: 1.5,
};

/**
 * The only tokens allowed as text on glass. `ink-3` and `accent-ink` would
 * need a near-opaque tint, so on glass Ion appears only as a graphic.
 */
export const GLASS_TEXT_TOKENS = ['ink', 'ink-2'] as const satisfies readonly SemanticColor[];

/** A token may be glass text only if its floor, with noise, stays at or below this. */
export const GLASS_TEXT_FLOOR_CAP = 0.85;

/** The search granularity for the floor. */
export const GLASS_ALPHA_STEP = 0.005;

export interface ScrimOptions {
  readonly noiseAlpha: number;
  readonly target: number;
  readonly step: number;
}

const DEFAULT_SCRIM_OPTIONS: ScrimOptions = {
  noiseAlpha: GLASS_SPEC.noiseAlpha,
  target: 4.5,
  step: GLASS_ALPHA_STEP,
};

/** Rounds away binary noise from step arithmetic (0.775 stays 0.775). */
function roundAlpha(alpha: number): number {
  return Math.round(alpha * 1e6) / 1e6;
}

/**
 * Every color the glass can show at a tint opacity: the tint over black and
 * over white, each shifted toward black and toward white by the noise.
 */
export function glassComposites(tint: Rgb, alpha: number, noiseAlpha: number): Rgb[] {
  return [BLACK, WHITE].flatMap((backdrop) => {
    const base = compositeOver(tint, alpha, backdrop);
    return noiseAlpha === 0
      ? [base]
      : [base, compositeOver(BLACK, noiseAlpha, base), compositeOver(WHITE, noiseAlpha, base)];
  });
}

/** The worst contrast of `text` over every glass composite at `alpha`. */
export function worstGlassContrast(
  tint: Rgb,
  text: Rgb,
  alpha: number,
  noiseAlpha: number,
): number {
  return Math.min(
    ...glassComposites(tint, alpha, noiseAlpha).map((composite) => contrastRatio(text, composite)),
  );
}

/**
 * The smallest tint opacity, in `step` increments, at which `text` reaches
 * `target` over every glass composite; `null` when even an opaque tint fails.
 */
export function minimumScrimAlpha(
  tint: Rgb,
  text: Rgb,
  options: Partial<ScrimOptions> = {},
): number | null {
  const { noiseAlpha, target, step } = { ...DEFAULT_SCRIM_OPTIONS, ...options };
  const steps = Math.round(1 / step);
  for (let index = 0; index <= steps; index += 1) {
    const alpha = roundAlpha(index * step);
    if (worstGlassContrast(tint, text, alpha, noiseAlpha) >= target) {
      return alpha;
    }
  }
  return null;
}

/** The tint opacity the CSS ships: the recipe, raised to the floor when needed. */
export function glassTintAlpha(spec: GlassSpec, theme: Theme, floor: number): number {
  return roundAlpha(Math.max(spec.recipeAlpha[theme], floor));
}
