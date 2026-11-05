/**
 * Gallery entries: one per primitive plus token and icon sheets.
 *
 * Every entry renders deterministically (fixed data, no clocks), because the
 * harness screenshots it against a visual baseline.
 */

import type { ReactNode } from 'react';

import { contrastRatio } from '../tokens/color-math.js';
import { DRSHYA_TOKENS, resolveRgb } from '../tokens/emit.js';
import { CONTRAST_PAIRINGS, type ContrastPairing } from '../tokens/pairings.js';
import { THEMES } from '../tokens/palette.js';
import { SEMANTIC_COLOR_NAMES } from '../tokens/semantic.js';

import { BG_CLASS, TEXT_CLASS } from './classes.js';

export interface GalleryEntry {
  /** Kebab-case and unique; used in the URL and in baseline file names. */
  readonly id: string;
  readonly title: string;
  /** The export name in `src/primitives/index.ts`, or `null` for sheets. */
  readonly primitive: string | null;
  readonly render: () => ReactNode;
  /** Whether the harness walks focus through this entry. */
  readonly interactive: boolean;
}

function ratioLabel(pairing: ContrastPairing): string {
  return THEMES.map((theme) => {
    const ratio = contrastRatio(
      resolveRgb(DRSHYA_TOKENS, pairing.fg, theme),
      resolveRgb(DRSHYA_TOKENS, pairing.bg, theme),
    );
    return `${theme} ${ratio.toFixed(2)}`;
  }).join(' · ');
}

function ColorSheet(): ReactNode {
  return (
    <ul className="grid grid-cols-4 gap-4">
      {SEMANTIC_COLOR_NAMES.map((color) => (
        <li key={color} className="flex flex-col gap-1">
          <div
            aria-hidden="true"
            className={`h-10 rounded-chip border border-rule-strong ${BG_CLASS[color]}`}
          />
          <span className="type-engine text-ink-2">{color}</span>
        </li>
      ))}
    </ul>
  );
}

function PairingSample({ pairing }: { readonly pairing: ContrastPairing }): ReactNode {
  const label = `${pairing.fg} on ${pairing.bg}`;
  if (pairing.kind === 'text') {
    return (
      <li className={`flex items-baseline justify-between gap-4 px-3 py-2 ${BG_CLASS[pairing.bg]}`}>
        <span className={TEXT_CLASS[pairing.fg]}>{label}</span>
        <span className={`type-engine ${TEXT_CLASS[pairing.fg]}`}>{ratioLabel(pairing)}</span>
      </li>
    );
  }
  // Non-text pairings are shown as the graphic they govern, labelled in ink.
  return (
    <li className={`flex items-center justify-between gap-4 px-3 py-2 ${BG_CLASS[pairing.bg]}`}>
      <span className="flex items-center gap-2 text-ink">
        <span
          aria-hidden="true"
          className={`inline-block size-4 rounded-full ${BG_CLASS[pairing.fg]}`}
        />
        {label} (graphic)
      </span>
      <span className="type-engine text-ink">{ratioLabel(pairing)}</span>
    </li>
  );
}

function PairingSheet(): ReactNode {
  return (
    <ul className="flex flex-col border border-rule">
      {CONTRAST_PAIRINGS.map((pairing) => (
        <PairingSample key={`${pairing.fg}/${pairing.bg}`} pairing={pairing} />
      ))}
    </ul>
  );
}

/** The gallery's entries, in display order. */
export const GALLERY_ENTRIES: readonly GalleryEntry[] = [
  {
    id: 'tokens-colors',
    title: 'Semantic colors',
    primitive: null,
    render: () => <ColorSheet />,
    interactive: false,
  },
  {
    id: 'tokens-pairings',
    title: 'Contrast pairings',
    primitive: null,
    render: () => <PairingSheet />,
    interactive: false,
  },
];
