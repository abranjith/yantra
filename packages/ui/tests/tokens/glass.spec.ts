import { describe, expect, it } from 'vitest';

import { BLACK, WHITE, compositeOver, contrastRatio } from '../../src/tokens/color-math.js';
import {
  DRSHYA_TOKENS,
  computeGlassFloor,
  emitThemeCss,
  resolveGlassAlpha,
  resolveRgb,
  validateTokens,
  type TokenSet,
} from '../../src/tokens/emit.js';
import { TokenContractError } from '../../src/tokens/errors.js';
import {
  GLASS_ALPHA_STEP,
  GLASS_SPEC,
  GLASS_TEXT_FLOOR_CAP,
  GLASS_TEXT_TOKENS,
  glassComposites,
  glassTintAlpha,
  minimumScrimAlpha,
  worstGlassContrast,
} from '../../src/tokens/glass.js';
import { CONTRAST_PAIRINGS } from '../../src/tokens/pairings.js';
import { THEMES } from '../../src/tokens/palette.js';

import { blockBody, declarations } from './css-blocks.js';

const css = emitThemeCss();

function emittedAlpha(selectorBody: string): number {
  const line = declarations(selectorBody).find((entry) => entry.startsWith('--glass-alpha:'));
  if (line === undefined) {
    throw new Error('no --glass-alpha declaration');
  }
  return Number(line.slice('--glass-alpha:'.length, -1).trim());
}

const EMITTED = {
  light: emittedAlpha(blockBody(css, ':root')),
  dark: emittedAlpha(blockBody(css, '[data-theme="dark"]')),
} as const;

describe('@no-llm Drshya glass scrim floor', () => {
  it('keeps every glass text token at 4.5:1 over black and white, with the noise shift', () => {
    const failing = THEMES.flatMap((theme) => {
      const tint = resolveRgb(DRSHYA_TOKENS, 'glass-tint', theme);
      return GLASS_TEXT_TOKENS.filter(
        (token) =>
          worstGlassContrast(
            tint,
            resolveRgb(DRSHYA_TOKENS, token, theme),
            EMITTED[theme],
            GLASS_SPEC.noiseAlpha,
          ) < 4.5,
      ).map((token) => `${token} (${theme})`);
    });

    expect(failing).toEqual([]);
  });

  it('checks six composites per tint: two backdrops, each plain and noise-shifted both ways', () => {
    const tint = resolveRgb(DRSHYA_TOKENS, 'glass-tint', 'light');
    const composites = glassComposites(tint, 0.5, 0.03);

    expect(composites).toHaveLength(6);
    expect(composites).toContainEqual(compositeOver(tint, 0.5, BLACK));
    expect(composites).toContainEqual(compositeOver(WHITE, 0.03, compositeOver(tint, 0.5, WHITE)));
    expect(glassComposites(tint, 0.5, 0)).toHaveLength(2);
  });

  it('proves the floor is minimal: one step lower, some token fails', () => {
    for (const theme of THEMES) {
      const { floor } = computeGlassFloor(DRSHYA_TOKENS, theme);
      expect(floor).not.toBeNull();
      const lower = (floor ?? 0) - GLASS_ALPHA_STEP;
      const tint = resolveRgb(DRSHYA_TOKENS, 'glass-tint', theme);

      const anyFails = GLASS_TEXT_TOKENS.some(
        (token) =>
          worstGlassContrast(
            tint,
            resolveRgb(DRSHYA_TOKENS, token, theme),
            lower,
            GLASS_SPEC.noiseAlpha,
          ) < 4.5,
      );
      expect(anyFails).toBe(true);
    }
  });

  it('ships the pre-check numbers: light 0.775 and dark 0.8, both set by ink-2', () => {
    expect(EMITTED).toEqual({ light: 0.775, dark: 0.8 });
    for (const theme of THEMES) {
      const { floor, perToken } = computeGlassFloor(DRSHYA_TOKENS, theme);
      expect(perToken.get('ink-2')).toBe(floor);
      expect(perToken.get('ink') ?? 1).toBeLessThan(floor ?? 0);
    }
    expect(computeGlassFloor(DRSHYA_TOKENS, 'light').perToken.get('ink')).toBe(0.5);
    expect(computeGlassFloor(DRSHYA_TOKENS, 'dark').perToken.get('ink')).toBe(0.61);
  });

  it('never ships a tint below the recipe', () => {
    for (const theme of THEMES) {
      expect(EMITTED[theme]).toBeGreaterThanOrEqual(GLASS_SPEC.recipeAlpha[theme]);
      expect(resolveGlassAlpha(DRSHYA_TOKENS, theme)).toBe(EMITTED[theme]);
    }
  });

  it('keeps the recipe when it already exceeds the floor', () => {
    const generous = { ...GLASS_SPEC, recipeAlpha: { light: 0.9, dark: 0.95 } };

    expect(glassTintAlpha(generous, 'light', 0.775)).toBe(0.9);
    expect(glassTintAlpha(generous, 'dark', 0.8)).toBe(0.95);
    expect(glassTintAlpha(GLASS_SPEC, 'light', 0.775)).toBe(0.775);
  });

  it('emits the glass recipe as plain properties', () => {
    const root = declarations(blockBody(css, ':root'));

    expect(root).toContain('--glass-blur: 20px;');
    expect(root).toContain('--glass-saturate: 1.5;');
    expect(root).toContain('--glass-noise-alpha: 0.03;');
    expect(declarations(blockBody(css, '[data-theme="light"]'))).toContain('--glass-alpha: 0.775;');
  });

  it('keeps ink-3 and accent-ink off glass: their floors exceed the cap', () => {
    expect(GLASS_TEXT_TOKENS).not.toContain('ink-3');
    expect(GLASS_TEXT_TOKENS).not.toContain('accent-ink');

    for (const theme of THEMES) {
      const tint = resolveRgb(DRSHYA_TOKENS, 'glass-tint', theme);
      const ink3 = minimumScrimAlpha(tint, resolveRgb(DRSHYA_TOKENS, 'ink-3', theme));
      expect(ink3 ?? 1).toBeGreaterThan(GLASS_TEXT_FLOOR_CAP);
    }
  });

  it('refuses accent-ink as glass text: the light floor 0.925 (0.945 before D4) exceeds the 0.85 cap', () => {
    const set: TokenSet = {
      ...DRSHYA_TOKENS,
      glassTextTokens: [...GLASS_TEXT_TOKENS, 'accent-ink'],
    };

    let caught: unknown;
    try {
      emitThemeCss(set);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TokenContractError);
    expect((caught as TokenContractError).message).toContain(
      'accent-ink on glass (light) needs tint alpha 0.925 > cap 0.85',
    );
    expect(validateTokens(set).filter((failure) => failure.kind === 'glass-floor')).toHaveLength(1);
  });

  it('returns null when no opacity can work (text equal to the tint)', () => {
    const tint = resolveRgb(DRSHYA_TOKENS, 'glass-tint', 'light');

    expect(minimumScrimAlpha(tint, tint)).toBeNull();
  });

  it('reports an impossible glass token instead of crashing', () => {
    const set: TokenSet = { ...DRSHYA_TOKENS, glassTextTokens: ['glass-tint'] };

    const failures = validateTokens(set).filter((failure) => failure.kind === 'glass-floor');

    expect(failures).toHaveLength(2);
    expect(() => emitThemeCss(set)).toThrow('cannot reach 4.5:1 even with an opaque tint');
  });

  it('needs no tint at all for text that already passes over both extremes', () => {
    // Mid-gray text cannot pass over both black and white, but a target of 1 always can.
    expect(minimumScrimAlpha(WHITE, BLACK, { target: 1 })).toBe(0);
    expect(contrastRatio(WHITE, BLACK)).toBeGreaterThan(4.5);
  });

  it('declares glass text pairings in the contrast gate', () => {
    const glassPairings = CONTRAST_PAIRINGS.filter((pairing) => pairing.bg === 'glass');

    expect(glassPairings.map((pairing) => pairing.fg)).toEqual([...GLASS_TEXT_TOKENS]);
    expect(glassPairings.every((pairing) => pairing.kind === 'text')).toBe(true);
  });
});
