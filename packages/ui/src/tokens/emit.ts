/**
 * The Drshya token generator: validates the token data, then renders
 * `src/styles/theme.generated.css`.
 *
 * Pure and deterministic. `scripts/emit-tokens.ts` writes its output, and a
 * drift test compares the checked-in file against a fresh emit (spec S2).
 */

import {
  contrastRatio,
  formatOklch,
  oklchToLinearSrgb,
  oklchToSrgb,
  type Oklch,
  type Rgb,
} from './color-math.js';
import { TokenContractError, type TokenFailure } from './errors.js';
import {
  GLASS_SPEC,
  GLASS_TEXT_FLOOR_CAP,
  GLASS_TEXT_TOKENS,
  glassTintAlpha,
  minimumScrimAlpha,
  worstGlassContrast,
  type GlassSpec,
} from './glass.js';
import { CONTRAST_PAIRINGS, MINIMUM_CONTRAST, type ContrastPairing } from './pairings.js';
import { PRIMITIVES, THEMES, type PrimitiveToken, type Theme } from './palette.js';
import { CLEARED_NAMESPACES, FONT_FAMILIES, MOTION, RADIUS_SCALE, TYPE_SCALE } from './scale.js';
import { SEMANTIC_COLORS, SEMANTIC_COLOR_NAMES, type SemanticColor } from './semantic.js';

/** Everything the generator reads. Tests pass deliberately broken sets. */
export interface TokenSet {
  readonly primitives: readonly PrimitiveToken[];
  readonly semantic: Readonly<
    Record<SemanticColor, { readonly light: string; readonly dark: string }>
  >;
  readonly pairings: readonly ContrastPairing[];
  readonly glass: GlassSpec;
  /** The tokens allowed as text on glass; each must stay under the floor cap. */
  readonly glassTextTokens: readonly SemanticColor[];
}

/** The shipped token data. */
export const DRSHYA_TOKENS: TokenSet = {
  primitives: PRIMITIVES,
  semantic: SEMANTIC_COLORS,
  pairings: CONTRAST_PAIRINGS,
  glass: GLASS_SPEC,
  glassTextTokens: GLASS_TEXT_TOKENS,
};

/** The glass floor in one theme, overall and per glass text token. */
export interface GlassFloor {
  /** The largest token floor, or `null` when some token can never pass. */
  readonly floor: number | null;
  readonly perToken: ReadonlyMap<SemanticColor, number | null>;
}

/** The path of the generated stylesheet, relative to the package root. */
export const GENERATED_THEME_PATH = 'src/styles/theme.generated.css';

function primitiveIndex(set: TokenSet): ReadonlyMap<string, PrimitiveToken> {
  return new Map(set.primitives.map((primitive) => [primitive.name, primitive]));
}

/** The primitive name a semantic color points at in a theme. */
export function primitiveFor(set: TokenSet, color: SemanticColor, theme: Theme): string {
  return set.semantic[color][theme];
}

/**
 * Resolves a semantic color to its OKLCH value in a theme.
 *
 * @throws {TokenContractError} when the mapping names an unknown primitive.
 */
export function resolveOklch(set: TokenSet, color: SemanticColor, theme: Theme): Oklch {
  const name = primitiveFor(set, color, theme);
  const primitive = primitiveIndex(set).get(name);
  if (primitive === undefined) {
    throw new TokenContractError([{ kind: 'reference', semantic: color, theme, primitive: name }]);
  }
  return primitive[theme];
}

/** Resolves a semantic color to the sRGB color an sRGB screen shows. */
export function resolveRgb(set: TokenSet, color: SemanticColor, theme: Theme): Rgb {
  return oklchToSrgb(resolveOklch(set, color, theme)).rgb;
}

/** The scrim floor for a theme: the largest floor over the glass text tokens. */
export function computeGlassFloor(set: TokenSet, theme: Theme): GlassFloor {
  const tint = resolveRgb(set, 'glass-tint', theme);
  const perToken = new Map(
    set.glassTextTokens.map((token) => [
      token,
      minimumScrimAlpha(tint, resolveRgb(set, token, theme), { noiseAlpha: set.glass.noiseAlpha }),
    ]),
  );
  const floors = [...perToken.values()];
  return {
    floor: floors.includes(null)
      ? null
      : Math.max(0, ...floors.filter((floor): floor is number => floor !== null)),
    perToken,
  };
}

function glassFloorFailures(set: TokenSet): TokenFailure[] {
  return THEMES.flatMap((theme) =>
    [...computeGlassFloor(set, theme).perToken].flatMap(([token, floor]): TokenFailure[] =>
      floor === null || floor > GLASS_TEXT_FLOOR_CAP
        ? [{ kind: 'glass-floor', token, theme, floor, cap: GLASS_TEXT_FLOOR_CAP }]
        : [],
    ),
  );
}

/**
 * The tint opacity the CSS ships in a theme, `max(recipe, floor)`.
 *
 * @throws {TokenContractError} when no opacity makes glass text legible.
 */
export function resolveGlassAlpha(set: TokenSet, theme: Theme): number {
  const { floor } = computeGlassFloor(set, theme);
  if (floor === null) {
    throw new TokenContractError(glassFloorFailures(set));
  }
  return glassTintAlpha(set.glass, theme, floor);
}

function gamutFailures(set: TokenSet): TokenFailure[] {
  return set.primitives.flatMap((primitive) =>
    THEMES.flatMap((theme): TokenFailure[] => {
      if (oklchToSrgb(primitive[theme]).inGamut) {
        return [];
      }
      return [
        {
          kind: 'gamut',
          token: primitive.name,
          theme,
          linear: oklchToLinearSrgb(primitive[theme]),
        },
      ];
    }),
  );
}

function referenceFailures(set: TokenSet): TokenFailure[] {
  const known = primitiveIndex(set);
  return SEMANTIC_COLOR_NAMES.flatMap((color) =>
    THEMES.flatMap((theme): TokenFailure[] => {
      const name = primitiveFor(set, color, theme);
      return known.has(name)
        ? []
        : [{ kind: 'reference', semantic: color, theme, primitive: name }];
    }),
  );
}

/**
 * Contrast failures, measured on the clipped color an sRGB screen shows, so an
 * out-of-gamut token still reports its contrast alongside its gamut failure.
 */
/** A pairing's contrast in a theme; `null` for glass with no legible opacity. */
export function pairingRatio(set: TokenSet, pairing: ContrastPairing, theme: Theme): number | null {
  const fg = resolveRgb(set, pairing.fg, theme);
  if (pairing.bg !== 'glass') {
    return contrastRatio(fg, resolveRgb(set, pairing.bg, theme));
  }
  const { floor } = computeGlassFloor(set, theme);
  if (floor === null) {
    // Reported as a glass-floor failure; there is no opacity to measure at.
    return null;
  }
  return worstGlassContrast(
    resolveRgb(set, 'glass-tint', theme),
    fg,
    glassTintAlpha(set.glass, theme, floor),
    set.glass.noiseAlpha,
  );
}

function contrastFailures(set: TokenSet): TokenFailure[] {
  return set.pairings.flatMap((pairing) =>
    pairing.themes.flatMap((theme): TokenFailure[] => {
      const ratio = pairingRatio(set, pairing, theme);
      if (ratio === null) {
        return [];
      }
      const required = MINIMUM_CONTRAST[pairing.kind];
      if (ratio >= required) {
        return [];
      }
      return [
        {
          kind: 'contrast',
          fg: pairing.fg,
          bg: pairing.bg,
          pairingKind: pairing.kind,
          theme,
          ratio,
          required,
        },
      ];
    }),
  );
}

/** Every contract failure in the set; empty when the tokens are shippable. */
export function validateTokens(set: TokenSet = DRSHYA_TOKENS): TokenFailure[] {
  const references = referenceFailures(set);
  if (references.length > 0) {
    // Contrast cannot be measured against a color that does not exist.
    return [...gamutFailures(set), ...references];
  }
  return [...gamutFailures(set), ...glassFloorFailures(set), ...contrastFailures(set)];
}

function declaration(name: string, value: string, indent: string): string {
  return `${indent}${name}: ${value};`;
}

function semanticDeclarations(set: TokenSet, theme: Theme, indent: string): string[] {
  return SEMANTIC_COLOR_NAMES.map((color) =>
    declaration(`--color-${color}`, `var(--drshya-${primitiveFor(set, color, theme)})`, indent),
  );
}

/** Primitives whose value differs between themes, re-declared per theme block. */
function themedPrimitiveDeclarations(set: TokenSet, theme: Theme, indent: string): string[] {
  return set.primitives
    .filter((primitive) => formatOklch(primitive.light) !== formatOklch(primitive.dark))
    .map((primitive) =>
      declaration(`--drshya-${primitive.name}`, formatOklch(primitive[theme]), indent),
    );
}

/** One full theme body: color scheme, themed primitives, glass tint, every semantic color. */
function themeBody(set: TokenSet, theme: Theme, indent: string): string[] {
  return [
    declaration('color-scheme', theme, indent),
    ...themedPrimitiveDeclarations(set, theme, indent),
    declaration('--glass-alpha', String(resolveGlassAlpha(set, theme)), indent),
    ...semanticDeclarations(set, theme, indent),
  ];
}

function block(selector: string, body: readonly string[], indent = ''): string {
  return [`${indent}${selector} {`, ...body, `${indent}}`].join('\n');
}

/** The glass shadow; elevation elsewhere is luminance and hairlines. */
const GLASS_SHADOW = '0 1px 2px oklch(0 0 0 / 0.12), 0 8px 24px oklch(0 0 0 / 0.16)';

const HEADER = [
  '/*',
  ' * GENERATED by packages/ui/scripts/emit-tokens.ts from packages/ui/src/tokens/*.ts.',
  ' * Do not edit: change the token data and run `pnpm --filter @yantra/ui emit:tokens`.',
  ' * A drift test fails when this file and a fresh emit differ.',
  ' */',
].join('\n');

/**
 * Validates the tokens, then renders the theme stylesheet.
 *
 * Theme selectors are attribute selectors rather than `:root`-only, so any
 * subtree (the gallery's wrapper, a preview pane) can carry `data-theme`.
 *
 * @throws {TokenContractError} listing every failure when the tokens break
 *   their contract (gamut, references, glass floor, contrast).
 */
export function emitThemeCss(set: TokenSet = DRSHYA_TOKENS): string {
  const failures = validateTokens(set);
  if (failures.length > 0) {
    throw new TokenContractError(failures);
  }

  const primitives = block(':root', [
    declaration('color-scheme', 'light', '  '),
    ...set.primitives.map((primitive) =>
      declaration(`--drshya-${primitive.name}`, formatOklch(primitive.light), '  '),
    ),
    // Glass (spec S3): the tint opacity is computed, the rest is the recipe.
    declaration('--glass-alpha', String(resolveGlassAlpha(set, 'light')), '  '),
    declaration('--glass-blur', `${String(set.glass.blurPx)}px`, '  '),
    declaration('--glass-saturate', String(set.glass.saturate), '  '),
    declaration('--glass-noise-alpha', String(set.glass.noiseAlpha), '  '),
    // Motion durations are plain properties so reduced motion can zero them.
    ...Object.entries(MOTION.durations).map(([name, value]) =>
      declaration(`--duration-${name}`, value, '  '),
    ),
  ]);

  const theme = block('@theme', [
    // Spec S1: clear every default namespace Drshya replaces, so a default
    // utility (bg-red-500, rounded-2xl, text-xl, shadow-lg) compiles to nothing.
    ...CLEARED_NAMESPACES.map((namespace) => declaration(`--${namespace}-*`, 'initial', '  ')),
    ...semanticDeclarations(set, 'light', '  '),
    ...Object.entries(FONT_FAMILIES).map(([name, value]) =>
      declaration(`--font-${name}`, value, '  '),
    ),
    ...Object.entries(TYPE_SCALE).flatMap(([name, step]) => [
      declaration(`--text-${name}`, step.size, '  '),
      declaration(`--text-${name}--line-height`, step.lineHeight, '  '),
    ]),
    ...Object.entries(RADIUS_SCALE).map(([name, value]) =>
      declaration(`--radius-${name}`, value, '  '),
    ),
    // The only shadow: under glass, to separate it from the moving viewport.
    declaration('--shadow-glass', GLASS_SHADOW, '  '),
    declaration('--ease-standard', MOTION.easeStandard, '  '),
  ]);

  const systemDark = block('@media (prefers-color-scheme: dark)', [
    block(':root:not([data-theme="light"])', themeBody(set, 'dark', '    '), '  '),
  ]);

  const sections: readonly (readonly [comment: string, css: string])[] = [
    ['Primitive tier (spec S1): plain custom properties, never utilities.', primitives],
    ['Semantic tier: Tailwind generates utilities from these. Light values.', theme],
    ['Dark theme following the OS, unless data-theme pins light.', systemDark],
    ['Dark theme chosen explicitly.', block('[data-theme="dark"]', themeBody(set, 'dark', '  '))],
    [
      'Light theme chosen explicitly: holds even when the OS is dark.',
      block('[data-theme="light"]', themeBody(set, 'light', '  ')),
    ],
  ];

  return `${[HEADER, ...sections.map(([comment, css]) => `/* ${comment} */\n${css}`)].join('\n\n')}\n`;
}
