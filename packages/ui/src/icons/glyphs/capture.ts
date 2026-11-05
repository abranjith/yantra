import type { GlyphNode } from './glyph.js';

/** A capture: target brackets around a held frame. */
export const CAPTURE: GlyphNode = [
  ['path', { d: 'M3 8V5a2 2 0 0 1 2-2h3' }],
  ['path', { d: 'M16 3h3a2 2 0 0 1 2 2v3' }],
  ['path', { d: 'M21 16v3a2 2 0 0 1-2 2h-3' }],
  ['path', { d: 'M8 21H5a2 2 0 0 1-2-2v-3' }],
  ['rect', { x: '8', y: '8', width: '8', height: '8', rx: '1' }],
];
