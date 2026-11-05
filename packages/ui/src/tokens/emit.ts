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
import { CONTRAST_PAIRINGS, MINIMUM_CONTRAST, type ContrastPairing } from './pairings.js';
import { PRIMITIVES, THEMES, type PrimitiveToken, type Theme } from './palette.js';
import { SEMANTIC_COLORS, SEMANTIC_COLOR_NAMES, type SemanticColor } from './semantic.js';

/** Everything the generator reads. Tests pass deliberately broken sets. */
export interface TokenSet {
  readonly primitives: readonly PrimitiveToken[];
  readonly semantic: Readonly<
    Record<SemanticColor, { readonly light: string; readonly dark: string }>
  >;
  readonly pairings: readonly ContrastPairing[];
}

/** The shipped token data. */
export const DRSHYA_TOKENS: TokenSet = {
  primitives: PRIMITIVES,
  semantic: SEMANTIC_COLORS,
  pairings: CONTRAST_PAIRINGS,
};

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
function contrastFailures(set: TokenSet): TokenFailure[] {
  return set.pairings.flatMap((pairing) =>
    pairing.themes.flatMap((theme): TokenFailure[] => {
      const ratio = contrastRatio(
        resolveRgb(set, pairing.fg, theme),
        resolveRgb(set, pairing.bg, theme),
      );
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
  return [...gamutFailures(set), ...contrastFailures(set)];
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

/** One full theme body: color scheme, themed primitives, every semantic color. */
function themeBody(set: TokenSet, theme: Theme, indent: string): string[] {
  return [
    declaration('color-scheme', theme, indent),
    ...themedPrimitiveDeclarations(set, theme, indent),
    ...semanticDeclarations(set, theme, indent),
  ];
}

function block(selector: string, body: readonly string[], indent = ''): string {
  return [`${indent}${selector} {`, ...body, `${indent}}`].join('\n');
}

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
 *   their contract (gamut, references, contrast).
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
  ]);

  const theme = block('@theme', [
    declaration('--color-*', 'initial', '  '),
    ...semanticDeclarations(set, 'light', '  '),
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
