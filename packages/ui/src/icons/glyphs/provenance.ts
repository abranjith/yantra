import type { GlyphNode } from './glyph.js';

/** Provenance: the thread from goal to search to page to link. */
export const PROVENANCE: GlyphNode = [
  ['circle', { cx: '5', cy: '19', r: '2' }],
  ['circle', { cx: '12', cy: '12', r: '2' }],
  ['circle', { cx: '19', cy: '5', r: '2' }],
  ['path', { d: 'm6.5 17.5 4-4' }],
  ['path', { d: 'm13.5 10.5 4-4' }],
];
