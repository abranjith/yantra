/**
 * Gallery entries: one per primitive plus token and icon sheets.
 *
 * Every entry renders deterministically (fixed data, no clocks), because the
 * harness screenshots it against a visual baseline.
 */

import type { ReactNode } from 'react';

import { Icon } from '../icons/Icon.js';
import { ICON_NAMES } from '../icons/registry.js';
import { DRSHYA_TOKENS, pairingRatio } from '../tokens/emit.js';
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
    const ratio = pairingRatio(DRSHYA_TOKENS, pairing, theme);
    return `${theme} ${ratio === null ? 'n/a' : ratio.toFixed(2)}`;
  }).join(' · ');
}

/** The class that paints a pairing's background; glass pairings sit on real glass. */
function backgroundClass(pairing: ContrastPairing): string {
  return pairing.bg === 'glass' ? 'glass' : BG_CLASS[pairing.bg];
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
      <li
        className={`flex items-baseline justify-between gap-4 px-3 py-2 ${backgroundClass(pairing)}`}
      >
        <span className={TEXT_CLASS[pairing.fg]}>{label}</span>
        <span className={`type-engine ${TEXT_CLASS[pairing.fg]}`}>{ratioLabel(pairing)}</span>
      </li>
    );
  }
  // Non-text pairings are shown as the graphic they govern, labelled in ink.
  return (
    <li className={`flex items-center justify-between gap-4 px-3 py-2 ${backgroundClass(pairing)}`}>
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

/** Static class names per type step, so Tailwind generates each one. */
const TYPE_SAMPLES = [
  { name: 'micro', className: 'text-micro' },
  { name: 'caption', className: 'text-caption' },
  { name: 'body', className: 'text-body' },
  { name: 'lead', className: 'text-lead' },
  { name: 'title', className: 'text-title' },
  { name: 'headline', className: 'text-headline' },
] as const;

const RADIUS_SAMPLES = [
  { name: 'chip', className: 'rounded-chip' },
  { name: 'control', className: 'rounded-control' },
  { name: 'frame', className: 'rounded-frame' },
  { name: 'full', className: 'rounded-full' },
] as const;

function TypeShapeMotionSheet(): ReactNode {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <span className="type-label text-ink-2">Mission</span>
        <span className="type-display text-ink">00:42</span>
        <p className="type-body text-ink">
          Compare the return policies of three outdoor-gear stores and cite each one.
        </p>
        <p className="type-agent" data-voice="agent">
          understood: three stores, the return window and restocking fee, each with a citation.
        </p>
        <p className="type-engine text-ink" data-voice="engine">
          browser_fill_form #07 A6
        </p>
      </div>
      <ul className="flex flex-col gap-1">
        {TYPE_SAMPLES.map((sample) => (
          <li key={sample.name} className={`text-ink ${sample.className}`}>
            {sample.name}: Evidence before eloquence
          </li>
        ))}
      </ul>
      <ul className="flex items-end gap-4">
        {RADIUS_SAMPLES.map((sample) => (
          <li key={sample.name} className="flex flex-col items-center gap-1">
            <span
              aria-hidden="true"
              className={`block size-12 border border-rule-strong bg-sunken ${sample.className}`}
            />
            <span className="type-engine text-ink-2">{sample.name}</span>
          </li>
        ))}
        <li className="flex flex-col items-center gap-1">
          {/* A banned default: the class compiles to nothing (spec S1). */}
          <span
            aria-hidden="true"
            data-banned-radius
            className="block size-12 rounded-2xl border border-rule-strong bg-sunken"
          />
          <span className="type-engine text-ink-2">2xl (none)</span>
        </li>
      </ul>
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          data-motion-loop
          className="gallery-motion-loop block size-3 rounded-full bg-accent"
        />
        <span className="text-ink-2">A loop that reduced motion stops</span>
      </div>
    </div>
  );
}

/** Every registry name with its label, at 16 and 20 px. */
function IconSheet(): ReactNode {
  return (
    <ul className="grid grid-cols-3 gap-x-6 gap-y-2">
      {ICON_NAMES.map((name) => (
        <li key={name} className="flex items-center gap-3 text-ink">
          <Icon name={name} size={16} />
          <Icon name={name} size={20} />
          <span className="type-engine text-ink-2">{name}</span>
        </li>
      ))}
    </ul>
  );
}

const GLASS_BACKDROPS = [
  { id: 'black', label: 'Over black', className: 'gallery-backdrop-black' },
  { id: 'white', label: 'Over white', className: 'gallery-backdrop-white' },
  { id: 'stripes', label: 'Over stripes', className: 'gallery-backdrop-stripes' },
] as const;

/**
 * A glass panel over the two analytic extremes and a busy pattern. The lower
 * right of each panel stays empty: the harness samples the tint there, over a
 * 64 px window that holds exactly one period of the noise tile.
 */
function GlassSheet(): ReactNode {
  return (
    <div className="grid grid-cols-3 gap-4">
      {GLASS_BACKDROPS.map((backdrop) => (
        <div
          key={backdrop.id}
          data-glass-backdrop={backdrop.id}
          className={`p-10 ${backdrop.className}`}
        >
          <div data-glass-panel className="glass flex h-56 flex-col gap-2 rounded-frame p-4">
            <p className="text-ink">{backdrop.label}: ink</p>
            <p className="text-ink-2">Secondary ink on glass</p>
            <span className="flex items-center gap-2 text-ink-2">
              <span
                aria-hidden="true"
                className="inline-block size-3 rounded-full bg-accent outline-2 outline-offset-2 outline-accent"
              />
              Ion as a graphic only
            </span>
          </div>
        </div>
      ))}
    </div>
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
  {
    id: 'surfaces-glass',
    title: 'Glass and Solid surfaces',
    primitive: null,
    render: () => <GlassSheet />,
    interactive: false,
  },
  {
    id: 'tokens-type-shape-motion',
    title: 'Type, shape and motion',
    primitive: null,
    render: () => <TypeShapeMotionSheet />,
    interactive: false,
  },
  {
    id: 'icons',
    title: 'Icons',
    primitive: null,
    render: () => <IconSheet />,
    interactive: false,
  },
];
