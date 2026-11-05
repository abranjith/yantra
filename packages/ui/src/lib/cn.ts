/**
 * Class merging that knows Drshya's names.
 *
 * tailwind-merge's default theme treats any `text-*` word as a color, so
 * `cn('text-ink-2', 'text-body')` would drop the color. Overriding the color,
 * type, radius and shadow scales with Drshya's own names makes merges resolve
 * by meaning: a later color replaces an earlier color, and a size leaves a
 * color alone.
 */

import { extendTailwindMerge, type ClassNameValue } from 'tailwind-merge';
import { createTV } from 'tailwind-variants';

import { RADIUS_SCALE, TYPE_SCALE } from '../tokens/scale.js';
import { SEMANTIC_COLOR_NAMES } from '../tokens/semantic.js';

const drshyaMerge = extendTailwindMerge({
  override: {
    theme: {
      color: [...SEMANTIC_COLOR_NAMES],
      text: Object.keys(TYPE_SCALE),
      radius: Object.keys(RADIUS_SCALE),
      shadow: ['glass'],
    },
  },
});

/** Joins class names and resolves conflicts the Drshya way; later classes win. */
export function cn(...classes: ClassNameValue[]): string {
  return drshyaMerge(...classes);
}

/** `tailwind-variants` bound to the same merger as {@link cn}. */
export const tv = createTV({ twMerge: (classList: string) => drshyaMerge(classList) });

/**
 * The visible focus ring: a solid 2 px Ion outline, offset 2 px, shown only for
 * keyboard focus (React Aria's `data-focus-visible`). The ring passes 3:1
 * against `bg` and `surface` through the contrast gate.
 */
export const focusRing = tv({
  // outline-hidden, not outline-none: it keeps a transparent outline that
  // forced-colors mode can show, and does not pin --tw-outline-style to none.
  base: 'outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
});
