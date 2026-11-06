import type { GlyphNode } from './glyph.js';

/** The Bindu: a square inside a circle around a center point; engine state everywhere. */
export const BINDU: GlyphNode = [
  ['circle', { cx: '12', cy: '12', r: '9.5' }],
  ['rect', { x: '7.5', y: '7.5', width: '9', height: '9', rx: '0.5' }],
  ['circle', { cx: '12', cy: '12', r: '1' }],
];
