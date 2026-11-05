/**
 * A custom Drshya glyph is pure geometry on Lucide's 24 px grid: a list of SVG
 * child elements. `registry.tsx` turns each into a component with Lucide's
 * own `createLucideIcon`, so glyphs inherit Lucide's exact SVG contract
 * (viewBox, `fill="none"`, `stroke="currentColor"`, round caps and joins,
 * stroke width from props) and are indistinguishable from Lucide icons.
 *
 * Drawing rules: keep geometry inside the 2..22 live area, use strokes rather
 * than fills, and no literal religious iconography (brainstorm).
 */

export type GlyphElement = 'circle' | 'line' | 'path' | 'rect';

export type GlyphNode = readonly (readonly [
  element: GlyphElement,
  attributes: Readonly<Record<string, string>>,
])[];
