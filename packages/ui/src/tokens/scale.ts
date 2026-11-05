/**
 * Drshya type, radius and motion tokens (`.spec-lite/ui_brainstorm.md`
 * §Typography, §Shape, §Motion).
 *
 * The generated `@theme` clears Tailwind's default font, text, radius,
 * shadow and animation namespaces and declares only these, so a default such
 * as `rounded-2xl` or `text-xl` compiles to nothing (spec S1). Spacing keeps
 * Tailwind's `--spacing` (0.25rem, the brainstorm's 4 px base; spec S11).
 */

export interface TypeStep {
  readonly size: string;
  /** Unitless line height. */
  readonly lineHeight: string;
}

/** The seven-step type scale, in rem. */
export const TYPE_SCALE = {
  micro: { size: '0.72rem', lineHeight: '1.4' },
  caption: { size: '0.8125rem', lineHeight: '1.4' },
  body: { size: '0.9375rem', lineHeight: '1.5' },
  lead: { size: '1.125rem', lineHeight: '1.5' },
  title: { size: '1.5rem', lineHeight: '1.25' },
  headline: { size: '2.25rem', lineHeight: '1.15' },
  display: { size: 'clamp(2.25rem, 1rem + 4vw, 4.1rem)', lineHeight: '1.05' },
} as const satisfies Record<string, TypeStep>;

export type TypeName = keyof typeof TYPE_SCALE;

/** Radius: chips and badges, controls and plates, the cockpit frame, pills. */
export const RADIUS_SCALE = {
  chip: '4px',
  control: '8px',
  frame: '14px',
  full: '9999px',
} as const satisfies Record<string, string>;

export type RadiusName = keyof typeof RADIUS_SCALE;

/** Self-hosted families (Fontsource variable builds with the width axis). */
export const FONT_FAMILIES = {
  sans: '"Archivo Variable", system-ui, sans-serif',
  mono: '"Martian Mono Variable", ui-monospace, monospace',
} as const satisfies Record<string, string>;

/** Motion means something or it does not exist. */
export const MOTION = {
  durations: { quick: '120ms', base: '200ms', slow: '320ms' },
  easeStandard: 'cubic-bezier(0.2, 0, 0, 1)',
} as const;

/**
 * Tailwind namespaces Drshya replaces wholesale (spec S1). Each is reset with
 * `--<namespace>-*: initial` before Drshya declares its own values.
 */
export const CLEARED_NAMESPACES = [
  'color',
  'font',
  'text',
  'radius',
  'shadow',
  'inset-shadow',
  'drop-shadow',
  'animate',
  'ease',
] as const;
