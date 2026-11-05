import { describe, expect, it } from 'vitest';

import {
  BLACK,
  WHITE,
  compositeOver,
  contrastRatio,
  formatOklch,
  isInGamut,
  oklch,
  oklchToLinearSrgb,
  oklchToSrgb,
  relativeLuminance,
  type Rgb,
} from '../../src/tokens/color-math.js';

const ONE_STEP = 1 / 255;

function expectRgbClose(actual: Rgb, expected: Rgb, tolerance = ONE_STEP): void {
  actual.forEach((channel, index) => {
    expect(Math.abs(channel - (expected[index] ?? Number.NaN))).toBeLessThanOrEqual(tolerance);
  });
}

describe('@no-llm Drshya color math', () => {
  describe('oklchToSrgb', () => {
    it('converts oklch(1 0 0) to white, in gamut', () => {
      const result = oklchToSrgb(oklch(1, 0, 0));

      expectRgbClose(result.rgb, WHITE, 1e-6);
      expect(result.inGamut).toBe(true);
    });

    it('converts oklch(0 0 0) to black, in gamut', () => {
      const result = oklchToSrgb(oklch(0, 0, 0));

      expectRgbClose(result.rgb, BLACK, 1e-9);
      expect(result.inGamut).toBe(true);
    });

    it('converts the reference OKLCH for sRGB red within one 8-bit step', () => {
      // CSS Color 4 reference value for #ff0000.
      expectRgbClose(oklchToSrgb(oklch(0.62796, 0.25768, 29.2339)).rgb, [1, 0, 0]);
    });

    it('converts the reference OKLCH for sRGB lime within one 8-bit step', () => {
      // CSS Color 4 reference value for #00ff00.
      expectRgbClose(oklchToSrgb(oklch(0.86644, 0.29483, 142.4953)).rgb, [0, 1, 0]);
    });

    it('keeps neutral fog steps achromatic within one 8-bit step', () => {
      const [r, g, b] = oklchToSrgb(oklch(0.64, 0, 255)).rgb;

      expect(Math.abs(r - g)).toBeLessThan(ONE_STEP);
      expect(Math.abs(g - b)).toBeLessThan(ONE_STEP);
    });

    it('treats hue 0 and 360 as the same color', () => {
      expectRgbClose(
        oklchToSrgb(oklch(0.6, 0.1, 0)).rgb,
        oklchToSrgb(oklch(0.6, 0.1, 360)).rgb,
        1e-9,
      );
    });

    it('clips an out-of-gamut color per channel and reports it', () => {
      // The brainstorm's light Ion fill: red goes below zero (spec D4).
      const color = oklch(0.55, 0.14, 218);
      const linear = oklchToLinearSrgb(color);
      const result = oklchToSrgb(color);

      expect(linear[0]).toBeLessThan(0);
      expect(result.inGamut).toBe(false);
      expect(result.rgb[0]).toBe(0);
      result.rgb.forEach((channel) => {
        expect(channel).toBeGreaterThanOrEqual(0);
        expect(channel).toBeLessThanOrEqual(1);
      });
    });

    it('clips channels above one', () => {
      const result = oklchToSrgb(oklch(1, 0.3, 30));

      expect(result.inGamut).toBe(false);
      expect(Math.max(...result.rgb)).toBeCloseTo(1, 12);
    });
  });

  describe('isInGamut', () => {
    it('accepts the cube edges and rejects anything beyond rounding noise', () => {
      expect(isInGamut([0, 0, 0])).toBe(true);
      expect(isInGamut([1, 1, 1])).toBe(true);
      expect(isInGamut([1 + 1e-9, 0.5, -1e-9])).toBe(true);
      expect(isInGamut([1.001, 0.5, 0.5])).toBe(false);
      expect(isInGamut([0.5, -0.001, 0.5])).toBe(false);
    });
  });

  describe('relativeLuminance and contrastRatio', () => {
    it('gives white luminance 1 and black luminance 0', () => {
      expect(relativeLuminance(WHITE)).toBeCloseTo(1, 10);
      expect(relativeLuminance(BLACK)).toBe(0);
    });

    it('weights green above red above blue', () => {
      const red = relativeLuminance([1, 0, 0]);
      const green = relativeLuminance([0, 1, 0]);
      const blue = relativeLuminance([0, 0, 1]);

      expect(green).toBeGreaterThan(red);
      expect(red).toBeGreaterThan(blue);
      expect(red + green + blue).toBeCloseTo(1, 10);
    });

    it('rates white on black at 21:1', () => {
      expect(contrastRatio(WHITE, BLACK)).toBeCloseTo(21, 10);
    });

    it('rates a color on itself at 1:1', () => {
      const color: Rgb = [0.3, 0.6, 0.9];

      expect(contrastRatio(color, color)).toBe(1);
    });

    it('is symmetric', () => {
      const a: Rgb = [0.2, 0.4, 0.6];
      const b: Rgb = [0.9, 0.8, 0.7];

      expect(contrastRatio(a, b)).toBe(contrastRatio(b, a));
    });

    it('matches the WCAG reference value for #767676 on white (4.54:1)', () => {
      const gray = 0x76 / 255;

      expect(contrastRatio([gray, gray, gray], WHITE)).toBeCloseTo(4.54, 2);
    });
  });

  describe('compositeOver', () => {
    const fg: Rgb = [0.2, 0.5, 0.8];
    const backdrop: Rgb = [1, 0, 0.5];

    it('equals the backdrop at alpha 0', () => {
      expect(compositeOver(fg, 0, backdrop)).toEqual(backdrop);
    });

    it('equals the foreground at alpha 1', () => {
      expect(compositeOver(fg, 1, backdrop)).toEqual(fg);
    });

    it('mixes linearly in encoded space at intermediate alpha', () => {
      expectRgbClose(compositeOver(fg, 0.25, backdrop), [0.8, 0.125, 0.575], 1e-12);
    });
  });

  describe('formatOklch', () => {
    it('renders the shortest numeric form', () => {
      expect(formatOklch(oklch(0.994, 0.002, 255))).toBe('oklch(0.994 0.002 255)');
      expect(formatOklch(oklch(1, 0, 0))).toBe('oklch(1 0 0)');
      expect(formatOklch(oklch(0.8, 0.14, 218))).toBe('oklch(0.8 0.14 218)');
    });
  });
});
