/**
 * The contrast pairings the token build must satisfy (WCAG 2.2 AA).
 *
 * Every pairing is checked in each listed theme; a failure stops the build
 * with a `TokenContractError` (spec §2, TASK-002).
 */

import { GLASS_TEXT_TOKENS } from './glass.js';
import { THEMES, type Theme } from './palette.js';
import type { SemanticColor } from './semantic.js';

/** `text` needs 4.5:1; `non-text` (glyphs, fills, rings, boundaries) needs 3:1. */
export type PairingKind = 'text' | 'non-text';

/**
 * What a foreground sits on: a semantic color, or `'glass'` — the glass
 * composite at the shipped tint opacity over pure black and pure white, with
 * the noise shift (spec S3).
 */
export type PairingBackground = SemanticColor | 'glass';

export interface ContrastPairing {
  readonly fg: SemanticColor;
  readonly bg: PairingBackground;
  readonly kind: PairingKind;
  readonly themes: readonly Theme[];
}

/** The minimum contrast ratio for a pairing kind. */
export const MINIMUM_CONTRAST: Readonly<Record<PairingKind, number>> = {
  text: 4.5,
  'non-text': 3,
};

/** Every text color the app sets on a solid surface. */
export const TEXT_INKS = [
  'ink',
  'ink-2',
  'ink-3',
  'accent-ink',
  'signal-fulfilled-ink',
  'signal-partial-ink',
  'signal-failed-ink',
  'signal-needs-you-ink',
] as const satisfies readonly SemanticColor[];

/** Graphic signal tokens: glyphs, fills and rings. */
export const SIGNAL_GRAPHICS = [
  'signal-fulfilled',
  'signal-partial',
  'signal-failed',
  'signal-needs-you',
] as const satisfies readonly SemanticColor[];

/** The solid surfaces content sits on. */
export const SOLID_SURFACES = [
  'bg',
  'surface',
  'sunken',
] as const satisfies readonly SemanticColor[];

function each(
  fgs: readonly SemanticColor[],
  bgs: readonly PairingBackground[],
  kind: PairingKind,
): ContrastPairing[] {
  return fgs.flatMap((fg) => bgs.map((bg) => ({ fg, bg, kind, themes: THEMES })));
}

/** The initial pairing set (spec §2 `ContrastPairing`). */
export const CONTRAST_PAIRINGS: readonly ContrastPairing[] = [
  ...each(TEXT_INKS, SOLID_SURFACES, 'text'),
  ...each(['on-accent'], ['accent'], 'text'),
  // Tooltips are the inverse solid surface.
  ...each(['surface'], ['ink'], 'text'),
  ...each([...SIGNAL_GRAPHICS, 'field-edge'], SOLID_SURFACES, 'non-text'),
  // The focus ring.
  ...each(['accent'], ['bg', 'surface'], 'non-text'),
  ...each(GLASS_TEXT_TOKENS, ['glass'], 'text'),
];
