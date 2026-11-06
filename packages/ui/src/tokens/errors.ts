/**
 * The error the token generator raises when the token data breaks its
 * contract. It lists every failure, never just the first, so one build run
 * shows everything that needs fixing.
 */

import type { PairingBackground, PairingKind } from './pairings.js';
import type { Theme } from './palette.js';
import type { SemanticColor } from './semantic.js';

/** A primitive whose OKLCH value lies outside the sRGB gamut in a theme. */
export interface GamutFailure {
  readonly kind: 'gamut';
  readonly token: string;
  readonly theme: Theme;
  /** The unclipped linear-light sRGB channels, for the message. */
  readonly linear: readonly [number, number, number];
}

/** A declared pairing that misses its minimum contrast in a theme. */
export interface ContrastFailure {
  readonly kind: 'contrast';
  readonly fg: SemanticColor;
  readonly bg: PairingBackground;
  readonly pairingKind: PairingKind;
  readonly theme: Theme;
  readonly ratio: number;
  readonly required: number;
}

/** A glass text token whose computed scrim floor exceeds the allowed cap. */
export interface GlassFloorFailure {
  readonly kind: 'glass-floor';
  readonly token: SemanticColor;
  readonly theme: Theme;
  /** The computed floor, or `null` when even an opaque tint fails. */
  readonly floor: number | null;
  readonly cap: number;
}

/** A semantic color mapped to a primitive that does not exist. */
export interface ReferenceFailure {
  readonly kind: 'reference';
  readonly semantic: SemanticColor;
  readonly theme: Theme;
  readonly primitive: string;
}

export type TokenFailure = GamutFailure | ReferenceFailure | ContrastFailure | GlassFloorFailure;

/**
 * Formats a ratio for a failure message: two decimals, unless rounding would
 * print a value that reads as passing, in which case three truncated decimals
 * (4.4996 reads "4.499", never "4.50").
 */
export function formatRatio(ratio: number, required: number): string {
  const rounded = ratio.toFixed(2);
  return Number(rounded) < required ? rounded : (Math.floor(ratio * 1000) / 1000).toFixed(3);
}

/** One line per failure, e.g. `on-accent/accent (light) 4.39 < 4.5`. */
export function describeFailure(failure: TokenFailure): string {
  switch (failure.kind) {
    case 'gamut':
      return `${failure.token} (${failure.theme}) is outside the sRGB gamut: linear rgb ${failure.linear
        .map((channel) => channel.toFixed(4))
        .join(' ')}`;
    case 'reference':
      return `${failure.semantic} (${failure.theme}) points at unknown primitive ${failure.primitive}`;
    case 'contrast':
      return `${failure.fg}/${failure.bg} (${failure.theme}) ${formatRatio(failure.ratio, failure.required)} < ${String(failure.required)}`;
    case 'glass-floor':
      return failure.floor === null
        ? `${failure.token} on glass (${failure.theme}) cannot reach 4.5:1 even with an opaque tint`
        : `${failure.token} on glass (${failure.theme}) needs tint alpha ${String(failure.floor)} > cap ${String(failure.cap)}`;
  }
}

export class TokenContractError extends Error {
  readonly failures: readonly TokenFailure[];

  constructor(failures: readonly TokenFailure[]) {
    super(
      `Drshya token contract failed (${String(failures.length)} problem${failures.length === 1 ? '' : 's'}):\n` +
        failures.map((failure) => `  - ${describeFailure(failure)}`).join('\n') +
        '\nFix the values in packages/ui/src/tokens/*.ts, then run `pnpm --filter @yantra/ui emit:tokens`.',
    );
    this.name = 'TokenContractError';
    this.failures = failures;
  }
}
