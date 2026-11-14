import type { ReactNode } from 'react';

import { Icon } from '../icons/Icon.js';
import { tv } from '../lib/cn.js';
import { usePrefersReducedMotion } from '../lib/motion.js';

/**
 * The Bindu: Yantra's status mark in the app's top bar (FEAT-065, FEAT-067).
 *
 * Shell states (FEAT-065):
 * - `idle`: nothing is running.
 * - `live`: a run is in progress.
 * - `attention`: a run is waiting for you.
 *
 * Run states, driven by the cockpit (FEAT-067):
 * - `thinking`: a model turn is in progress (no tool active, not finished).
 * - `acting`: a tool or a deterministic phase is running.
 * - `needs_you`: the run waits for you, or its start needs a decision.
 * - `fulfilled`: the run ended fulfilled. Other outcomes show their word
 *   through `label`.
 *
 * The state is never conveyed by color alone: the accessible name says it.
 * `thinking` and `acting` breathe, except under reduced motion, where the
 * animation class is not applied at all.
 */
export type BinduState =
  | 'idle'
  | 'live'
  | 'attention'
  | 'thinking'
  | 'acting'
  | 'needs_you'
  | 'fulfilled';

export const BINDU_STATES: readonly BinduState[] = [
  'idle',
  'live',
  'attention',
  'thinking',
  'acting',
  'needs_you',
  'fulfilled',
];

/** The accessible name for each state, in the CLI's words. */
export const BINDU_LABELS: Readonly<Record<BinduState, string>> = {
  idle: 'Yantra status: idle',
  live: 'Yantra status: a run is in progress',
  attention: 'Yantra status: a run is waiting for you',
  thinking: 'Engine: thinking',
  acting: 'Engine: acting',
  needs_you: 'Engine: needs you',
  fulfilled: 'Engine: fulfilled',
};

/** States that breathe while motion is allowed. */
const MOVING: ReadonlySet<BinduState> = new Set(['thinking', 'acting']);

export const binduStyles = tv({
  base: 'inline-flex shrink-0 items-center justify-center',
  variants: {
    state: {
      idle: 'text-ink-3',
      live: 'text-accent',
      attention: 'text-signal-needs-you',
      thinking: 'text-accent',
      acting: 'text-accent',
      needs_you: 'text-signal-needs-you',
      fulfilled: 'text-signal-fulfilled',
    },
    moving: { true: 'bindu-pulse', false: '' },
  },
  defaultVariants: { state: 'idle', moving: false },
});

export interface BinduProps {
  readonly state?: BinduState;
  /** Overrides the state's accessible name (e.g. `Engine: partial`). */
  readonly label?: string;
  readonly className?: string;
}

/** The Bindu status mark; see {@link BinduState}. */
export function Bindu({ state = 'idle', label, className }: BinduProps): ReactNode {
  const reduced = usePrefersReducedMotion();
  return (
    <span
      role="img"
      aria-label={label ?? BINDU_LABELS[state]}
      data-state={state}
      className={binduStyles({ state, moving: MOVING.has(state) && !reduced, className })}
    >
      <Icon name="glyph.bindu" size={20} />
    </span>
  );
}
