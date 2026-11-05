/**
 * Static class names for each semantic color.
 *
 * Tailwind finds utilities by scanning source text, so a class assembled at
 * runtime (`bg-${color}`) would never be generated. These maps spell every
 * class out once.
 */

import type { SemanticColor } from '../tokens/semantic.js';

export const BG_CLASS = {
  bg: 'bg-bg',
  surface: 'bg-surface',
  sunken: 'bg-sunken',
  ink: 'bg-ink',
  'ink-2': 'bg-ink-2',
  'ink-3': 'bg-ink-3',
  rule: 'bg-rule',
  'rule-strong': 'bg-rule-strong',
  'field-edge': 'bg-field-edge',
  accent: 'bg-accent',
  'on-accent': 'bg-on-accent',
  'accent-ink': 'bg-accent-ink',
  'signal-fulfilled': 'bg-signal-fulfilled',
  'signal-partial': 'bg-signal-partial',
  'signal-failed': 'bg-signal-failed',
  'signal-needs-you': 'bg-signal-needs-you',
  'signal-fulfilled-ink': 'bg-signal-fulfilled-ink',
  'signal-partial-ink': 'bg-signal-partial-ink',
  'signal-failed-ink': 'bg-signal-failed-ink',
  'signal-needs-you-ink': 'bg-signal-needs-you-ink',
  'glass-tint': 'bg-glass-tint',
  'glass-edge': 'bg-glass-edge',
  'glass-spec': 'bg-glass-spec',
} as const satisfies Record<SemanticColor, string>;

export const TEXT_CLASS = {
  bg: 'text-bg',
  surface: 'text-surface',
  sunken: 'text-sunken',
  ink: 'text-ink',
  'ink-2': 'text-ink-2',
  'ink-3': 'text-ink-3',
  rule: 'text-rule',
  'rule-strong': 'text-rule-strong',
  'field-edge': 'text-field-edge',
  accent: 'text-accent',
  'on-accent': 'text-on-accent',
  'accent-ink': 'text-accent-ink',
  'signal-fulfilled': 'text-signal-fulfilled',
  'signal-partial': 'text-signal-partial',
  'signal-failed': 'text-signal-failed',
  'signal-needs-you': 'text-signal-needs-you',
  'signal-fulfilled-ink': 'text-signal-fulfilled-ink',
  'signal-partial-ink': 'text-signal-partial-ink',
  'signal-failed-ink': 'text-signal-failed-ink',
  'signal-needs-you-ink': 'text-signal-needs-you-ink',
  'glass-tint': 'text-glass-tint',
  'glass-edge': 'text-glass-edge',
  'glass-spec': 'text-glass-spec',
} as const satisfies Record<SemanticColor, string>;
