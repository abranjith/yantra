import type { GlyphNode } from './glyph.js';

/** A handoff: the run passes control across a boundary to the person. */
export const HANDOFF: GlyphNode = [
  ['path', { d: 'M3 12h11' }],
  ['path', { d: 'm10 8 4 4-4 4' }],
  ['path', { d: 'M18 4v16' }],
  ['circle', { cx: '18', cy: '12', r: '3' }],
];
