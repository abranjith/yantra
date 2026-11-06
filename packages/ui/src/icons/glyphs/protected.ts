import type { GlyphNode } from './glyph.js';

/** A protected value: a shield over hatching, never the value itself. */
export const PROTECTED: GlyphNode = [
  [
    'path',
    {
      d: 'M12 21.5c-4.5-1.6-7.5-4.8-7.5-9.5V6l7.5-3 7.5 3v6c0 4.7-3 7.9-7.5 9.5z',
    },
  ],
  ['path', { d: 'M9 10h6' }],
  ['path', { d: 'M9 13h6' }],
  ['path', { d: 'M10 16h4' }],
];
