/**
 * Color math for the Drshya token generator: OKLCH to sRGB, WCAG 2.x relative
 * luminance and contrast, and source-over compositing.
 *
 * Everything here is pure and deterministic, so the contrast gate and the
 * glass scrim floor compute from exactly the values the CSS ships (spec S2).
 */

/** A color in OKLCH: lightness 0..1, chroma ≥ 0, hue in degrees. */
export interface Oklch {
  readonly l: number;
  readonly c: number;
  readonly h: number;
}

/** A gamma-encoded sRGB color with channels in 0..1. */
export type Rgb = readonly [number, number, number];

/** The result of converting OKLCH to sRGB. */
export interface SrgbConversion {
  /** Gamma-encoded sRGB, clipped per channel to 0..1 (what an sRGB screen shows). */
  readonly rgb: Rgb;
  /** Whether the unclipped linear color was inside the sRGB cube. */
  readonly inGamut: boolean;
}

/**
 * How far outside 0..1 a linear channel may sit and still count as in gamut.
 * Absorbs rounding in the published OKLab matrices (white lands at 1 + 1e-10),
 * and nothing more: a real excursion is many orders of magnitude larger.
 */
const GAMUT_EPSILON = 1e-6;

export const BLACK: Rgb = [0, 0, 0];
export const WHITE: Rgb = [1, 1, 1];

/** Builds an {@link Oklch} value. */
export function oklch(l: number, c: number, h: number): Oklch {
  return { l, c, h };
}

/** Renders a CSS `oklch()` value, e.g. `oklch(0.994 0.002 255)`. */
export function formatOklch(color: Oklch): string {
  return `oklch(${String(color.l)} ${String(color.c)} ${String(color.h)})`;
}

/** OKLCH to linear-light sRGB through OKLab (Björn Ottosson's matrices). */
export function oklchToLinearSrgb(color: Oklch): Rgb {
  const hue = (color.h * Math.PI) / 180;
  const a = color.c * Math.cos(hue);
  const b = color.c * Math.sin(hue);

  const l = (color.l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (color.l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (color.l - 0.0894841775 * a - 1.291485548 * b) ** 3;

  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function encodeChannel(linear: number): number {
  const clipped = Math.min(1, Math.max(0, linear));
  return clipped <= 0.0031308 ? 12.92 * clipped : 1.055 * clipped ** (1 / 2.4) - 0.055;
}

function decodeChannel(encoded: number): number {
  return encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;
}

/** Whether every linear channel lies inside the sRGB cube. */
export function isInGamut(linear: Rgb): boolean {
  return linear.every((channel) => channel >= -GAMUT_EPSILON && channel <= 1 + GAMUT_EPSILON);
}

/**
 * Converts OKLCH to gamma-encoded sRGB. Channels are clipped to 0..1, and
 * `inGamut` reports whether clipping was needed (an out-of-gamut token is a
 * generator error, spec D4).
 */
export function oklchToSrgb(color: Oklch): SrgbConversion {
  const linear = oklchToLinearSrgb(color);
  return {
    rgb: [encodeChannel(linear[0]), encodeChannel(linear[1]), encodeChannel(linear[2])],
    inGamut: isInGamut(linear),
  };
}

/** WCAG 2.x relative luminance of a gamma-encoded sRGB color. */
export function relativeLuminance(rgb: Rgb): number {
  return (
    0.2126 * decodeChannel(rgb[0]) + 0.7152 * decodeChannel(rgb[1]) + 0.0722 * decodeChannel(rgb[2])
  );
}

/** WCAG 2.x contrast ratio, 1..21, independent of argument order. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * Source-over compositing of `fg` at opacity `alpha` onto an opaque
 * `backdrop`, in gamma-encoded sRGB — how Chrome blends (spec S3).
 */
export function compositeOver(fg: Rgb, alpha: number, backdrop: Rgb): Rgb {
  const mix = (top: number, bottom: number) => top * alpha + bottom * (1 - alpha);
  return [mix(fg[0], backdrop[0]), mix(fg[1], backdrop[1]), mix(fg[2], backdrop[2])];
}
