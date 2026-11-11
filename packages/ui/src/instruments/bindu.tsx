import type { ReactNode } from 'react';

import { Icon } from '../icons/Icon.js';
import { tv } from '../lib/cn.js';

/**
 * The Bindu: Yantra's status mark in the app's top bar (FEAT-065).
 *
 * - `idle`: nothing is running.
 * - `live`: a run is in progress.
 * - `attention`: a run is waiting for you.
 *
 * FEAT-067 and FEAT-068 drive `live` and `attention`; FEAT-065 renders `idle`.
 * The state is never conveyed by color alone: the accessible name says it.
 */
export type BinduState = 'idle' | 'live' | 'attention';

export const BINDU_STATES: readonly BinduState[] = ['idle', 'live', 'attention'];

/** The accessible name for each state, in the CLI's words. */
export const BINDU_LABELS: Readonly<Record<BinduState, string>> = {
  idle: 'Yantra status: idle',
  live: 'Yantra status: a run is in progress',
  attention: 'Yantra status: a run is waiting for you',
};

export const binduStyles = tv({
  base: 'inline-flex shrink-0 items-center justify-center',
  variants: {
    state: {
      idle: 'text-ink-3',
      live: 'text-accent',
      attention: 'text-signal-needs-you',
    },
  },
  defaultVariants: { state: 'idle' },
});

export interface BinduProps {
  readonly state?: BinduState;
  /** Overrides the state's accessible name. */
  readonly label?: string;
  readonly className?: string;
}

/** The Bindu status mark; see {@link BinduState}. */
export function Bindu({ state = 'idle', label, className }: BinduProps): ReactNode {
  return (
    <span
      role="img"
      aria-label={label ?? BINDU_LABELS[state]}
      data-state={state}
      className={binduStyles({ state, className })}
    >
      <Icon name="glyph.bindu" size={20} />
    </span>
  );
}
