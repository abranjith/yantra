import { describe, expect, it } from 'vitest';

import { contrastRatio, oklch, oklchToSrgb, type Oklch } from '../../src/tokens/color-math.js';
import {
  DRSHYA_TOKENS,
  emitThemeCss,
  resolveRgb,
  validateTokens,
  type TokenSet,
} from '../../src/tokens/emit.js';
import {
  formatRatio,
  TokenContractError,
  type ContrastFailure,
  type TokenFailure,
} from '../../src/tokens/errors.js';
import {
  CONTRAST_PAIRINGS,
  MINIMUM_CONTRAST,
  SIGNAL_GRAPHICS,
  SOLID_SURFACES,
  TEXT_INKS,
} from '../../src/tokens/pairings.js';
import { PRIMITIVES, THEMES, type PrimitiveToken } from '../../src/tokens/palette.js';
import { SEMANTIC_COLORS } from '../../src/tokens/semantic.js';

/** The shipped set with one primitive's value replaced in one theme. */
function withPrimitive(name: string, theme: 'light' | 'dark', value: Oklch): TokenSet {
  return {
    ...DRSHYA_TOKENS,
    primitives: DRSHYA_TOKENS.primitives.map(
      (primitive): PrimitiveToken =>
        primitive.name === name ? { ...primitive, [theme]: value } : primitive,
    ),
  };
}

function thrownBy(run: () => unknown): TokenContractError {
  try {
    run();
  } catch (error) {
    if (error instanceof TokenContractError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected a TokenContractError');
}

const lightSignalInks = [
  'signal-fulfilled-ink',
  'signal-partial-ink',
  'signal-failed-ink',
  'signal-needs-you-ink',
] as const;

describe('@no-llm Drshya contrast gate', () => {
  it('ships tokens with no contract failures', () => {
    expect(validateTokens()).toEqual([]);
  });

  it('passes every declared pairing in every listed theme', () => {
    const failing = CONTRAST_PAIRINGS.flatMap((pairing) =>
      pairing.themes
        .map((theme) => ({
          label: `${pairing.fg}/${pairing.bg} (${theme})`,
          ratio: contrastRatio(
            resolveRgb(DRSHYA_TOKENS, pairing.fg, theme),
            resolveRgb(DRSHYA_TOKENS, pairing.bg, theme),
          ),
          required: MINIMUM_CONTRAST[pairing.kind],
        }))
        .filter((result) => result.ratio < result.required),
    );

    expect(failing).toEqual([]);
  });

  it('declares the pairing set from the spec', () => {
    const has = (fg: string, bg: string, kind: string) =>
      CONTRAST_PAIRINGS.some(
        (pairing) =>
          pairing.fg === fg &&
          pairing.bg === bg &&
          pairing.kind === kind &&
          pairing.themes.length === THEMES.length,
      );

    const missing = [
      ...TEXT_INKS.flatMap((ink) =>
        SOLID_SURFACES.filter((surface) => !has(ink, surface, 'text')).map(
          (surface) => `${ink}/${surface}`,
        ),
      ),
      ...[...SIGNAL_GRAPHICS, 'field-edge'].flatMap((graphic) =>
        SOLID_SURFACES.filter((surface) => !has(graphic, surface, 'non-text')).map(
          (surface) => `${graphic}/${surface}`,
        ),
      ),
    ];

    expect(missing).toEqual([]);
    expect(has('on-accent', 'accent', 'text')).toBe(true);
    expect(has('surface', 'ink', 'text')).toBe(true);
    expect(has('accent', 'bg', 'non-text')).toBe(true);
    expect(has('accent', 'surface', 'non-text')).toBe(true);
  });

  it('D1: white on the light Ion fill reaches 4.5:1', () => {
    const ratio = contrastRatio(
      resolveRgb(DRSHYA_TOKENS, 'on-accent', 'light'),
      resolveRgb(DRSHYA_TOKENS, 'accent', 'light'),
    );

    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  it('D1: on-accent on the dark Ion fill reaches 4.5:1', () => {
    const ratio = contrastRatio(
      resolveRgb(DRSHYA_TOKENS, 'on-accent', 'dark'),
      resolveRgb(DRSHYA_TOKENS, 'accent', 'dark'),
    );

    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  it('D2: every light signal ink reaches 4.5:1 on sunken, the worst light surface', () => {
    const failing = lightSignalInks.filter(
      (ink) =>
        contrastRatio(
          resolveRgb(DRSHYA_TOKENS, ink, 'light'),
          resolveRgb(DRSHYA_TOKENS, 'sunken', 'light'),
        ) < 4.5,
    );

    expect(failing).toEqual([]);
  });

  it('D2: every light graphic signal reaches 3:1 on sunken', () => {
    const failing = SIGNAL_GRAPHICS.filter(
      (graphic) =>
        contrastRatio(
          resolveRgb(DRSHYA_TOKENS, graphic, 'light'),
          resolveRgb(DRSHYA_TOKENS, 'sunken', 'light'),
        ) < 3,
    );

    expect(failing).toEqual([]);
  });

  it('D2: Jade and Amber keep a darker ink than their graphic in light, and share it in dark', () => {
    expect(SEMANTIC_COLORS['signal-fulfilled-ink'].light).toBe('jade-ink');
    expect(SEMANTIC_COLORS['signal-partial-ink'].light).toBe('amber-ink');

    for (const [graphic, ink] of [
      ['signal-fulfilled', 'signal-fulfilled-ink'],
      ['signal-partial', 'signal-partial-ink'],
    ] as const) {
      expect(resolveRgb(DRSHYA_TOKENS, ink, 'dark')).toEqual(
        resolveRgb(DRSHYA_TOKENS, graphic, 'dark'),
      );
    }
  });

  it('D4: every primitive is inside the sRGB gamut in both themes', () => {
    const outside = PRIMITIVES.flatMap((primitive) =>
      THEMES.filter((theme) => !oklchToSrgb(primitive[theme]).inGamut).map(
        (theme) => `${primitive.name} (${theme})`,
      ),
    );

    expect(outside).toEqual([]);
  });

  it('D4: reduced light chroma is the largest in-gamut value at 0.001 precision', () => {
    const reduced = ['ion-fill', 'ion-ink', 'jade', 'jade-ink', 'amber', 'amber-ink'];
    const primitives = PRIMITIVES.filter((primitive) => reduced.includes(primitive.name));

    const notMaximal = primitives
      .filter(
        ({ light: { l, c, h } }) =>
          oklchToSrgb(oklch(l, Math.round((c + 0.001) * 1000) / 1000, h)).inGamut,
      )
      .map((primitive) => primitive.name);

    expect(primitives.map((primitive) => primitive.name)).toEqual(reduced);
    expect(notMaximal).toEqual([]);
  });

  it('rejects the brainstorm light Ion fill with a failure naming the pairing and ratio', () => {
    const error = thrownBy(() =>
      emitThemeCss(withPrimitive('ion-fill', 'light', oklch(0.55, 0.14, 218))),
    );

    expect(error.message).toContain('on-accent/accent (light) 4.39 < 4.5');
    expect(error.message).toContain('ion-fill (light) is outside the sRGB gamut');
    expect(error.name).toBe('TokenContractError');
  });

  it('lists every failure in one error, not just the first', () => {
    const broken: TokenSet = {
      ...withPrimitive('fog-70', 'light', oklch(0.8, 0.011, 255)),
      primitives: withPrimitive('fog-70', 'light', oklch(0.8, 0.011, 255)).primitives.map(
        (primitive): PrimitiveToken =>
          primitive.name === 'jade-ink'
            ? { ...primitive, light: oklch(0.7, 0.05, 162) }
            : primitive,
      ),
    };

    const error = thrownBy(() => emitThemeCss(broken));
    const contrast = error.failures.filter(
      (failure): failure is ContrastFailure => failure.kind === 'contrast',
    );

    // ink-2 (fog-70) fails on all three light surfaces, and jade ink on all three too.
    expect(contrast.filter((failure) => failure.fg === 'ink-2')).toHaveLength(3);
    expect(contrast.filter((failure) => failure.fg === 'signal-fulfilled-ink')).toHaveLength(3);
    expect(contrast.every((failure) => failure.theme === 'light')).toBe(true);
    expect(error.message.split('\n').filter((line) => line.startsWith('  - '))).toHaveLength(
      error.failures.length,
    );
  });

  it('reports a semantic color that points at an unknown primitive', () => {
    const broken: TokenSet = {
      ...DRSHYA_TOKENS,
      semantic: { ...DRSHYA_TOKENS.semantic, ink: { light: 'fog-missing', dark: 'fog-05' } },
    };

    const failures = validateTokens(broken);

    expect(failures).toEqual<TokenFailure[]>([
      { kind: 'reference', semantic: 'ink', theme: 'light', primitive: 'fog-missing' },
    ]);
    expect(() => emitThemeCss(broken)).toThrow(
      'ink (light) points at unknown primitive fog-missing',
    );
  });

  it('reports a dark-only failure under the dark theme', () => {
    const failures = validateTokens(withPrimitive('ion-fill', 'dark', oklch(0.45, 0.1, 218)));

    expect(failures.length).toBeGreaterThan(0);
    expect(failures.every((failure) => 'theme' in failure && failure.theme === 'dark')).toBe(true);
  });

  describe('formatRatio', () => {
    it('uses two decimals for a clear failure', () => {
      expect(formatRatio(4.3853, 4.5)).toBe('4.39');
    });

    it('never prints a failing ratio that reads as passing', () => {
      expect(formatRatio(4.4996, 4.5)).toBe('4.499');
      expect(formatRatio(2.9999, 3)).toBe('2.999');
    });
  });
});
