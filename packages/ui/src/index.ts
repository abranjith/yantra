/**
 * `@yantra/ui` — Drshya, Yantra's design system.
 *
 * Browser code only: this package may import `@yantra/protocol` for types, and
 * never `@yantra/core`, `@yantra/agent` or a Node built-in (plan_ui §8
 * "Dependency direction"; enforced by `eslint.config.js`).
 */

/** The package's own name, so the build always has an entry point. */
export const DRSHYA_PACKAGE = '@yantra/ui' as const;

export {
  DEFAULT_APPEARANCE,
  SURFACES_PREFERENCES,
  THEME_PREFERENCES,
  appearanceAttributes,
  applyAppearance,
  parseAppearance,
  type Appearance,
  type AppearanceAttributes,
  type SurfacesPreference,
  type ThemePreference,
} from './appearance.js';
export { Icon, ICON_STROKE_WIDTH, type IconProps, type IconSize } from './icons/Icon.js';
export { ICON_NAMES, ICON_REGISTRY, type IconName, type IconRecord } from './icons/registry.js';
export {
  BLACK,
  WHITE,
  compositeOver,
  contrastRatio,
  formatOklch,
  oklch,
  oklchToSrgb,
  relativeLuminance,
  type Oklch,
  type Rgb,
  type SrgbConversion,
} from './tokens/color-math.js';
export {
  DRSHYA_TOKENS,
  computeGlassFloor,
  resolveGlassAlpha,
  resolveRgb,
  type GlassFloor,
  type TokenSet,
} from './tokens/emit.js';
export { TokenContractError, type TokenFailure } from './tokens/errors.js';
export {
  GLASS_SPEC,
  GLASS_TEXT_FLOOR_CAP,
  GLASS_TEXT_TOKENS,
  minimumScrimAlpha,
  type GlassSpec,
} from './tokens/glass.js';
export {
  PRIMITIVES,
  THEMES,
  type PrimitiveName,
  type PrimitiveToken,
  type Theme,
} from './tokens/palette.js';
export {
  CONTRAST_PAIRINGS,
  MINIMUM_CONTRAST,
  type ContrastPairing,
  type PairingKind,
} from './tokens/pairings.js';
export {
  SEMANTIC_COLORS,
  SEMANTIC_COLOR_NAMES,
  type SemanticColor,
  type SemanticMapping,
} from './tokens/semantic.js';
