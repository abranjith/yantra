import type { ReactNode } from 'react';

import { ICON_STROKE_WIDTH } from '../icons/Icon.js';
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
 * The state is never conveyed by color alone (REV-012, `ui_brainstorm.md`
 * §Motion). The accessible name says it, and each state has its own shape,
 * so the mark reads in grayscale and with motion off:
 * - `idle` is hollow: the ring and frame, no core;
 * - `live` and `thinking` show a small core;
 * - `acting` doubles the ring's weight;
 * - `attention` and `needs_you` show a large core;
 * - `fulfilled` is solid: the frame is filled.
 *
 * Motion adds to the shape, never replaces it: `thinking` breathes slowly,
 * `acting` pulses its ring, `needs_you` pulses its core fast. Under reduced
 * motion no animation class is applied at all.
 */
export type BinduState =
  'idle' | 'live' | 'attention' | 'thinking' | 'acting' | 'needs_you' | 'fulfilled';

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

/** The motion each state adds while motion is allowed, if any. */
export const BINDU_MOTION: Readonly<Record<BinduState, 'breathe' | 'ring' | 'core' | null>> = {
  idle: null,
  live: null,
  attention: null,
  thinking: 'breathe',
  acting: 'ring',
  needs_you: 'core',
  fulfilled: null,
};

/** The static shape of each state; see the module comment. */
export const BINDU_SHAPES: Readonly<
  Record<
    BinduState,
    { readonly core: 0 | 1.5 | 3; readonly ring: 'regular' | 'heavy'; readonly filled: boolean }
  >
> = {
  idle: { core: 0, ring: 'regular', filled: false },
  live: { core: 1.5, ring: 'regular', filled: false },
  attention: { core: 3, ring: 'regular', filled: false },
  thinking: { core: 1.5, ring: 'regular', filled: false },
  acting: { core: 1.5, ring: 'heavy', filled: false },
  needs_you: { core: 3, ring: 'regular', filled: false },
  fulfilled: { core: 1.5, ring: 'regular', filled: true },
};

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
    breathe: { true: 'bindu-pulse', false: '' },
  },
  defaultVariants: { state: 'idle', breathe: false },
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
  const motion = reduced ? null : BINDU_MOTION[state];
  const shape = BINDU_SHAPES[state];
  return (
    <span
      role="img"
      aria-label={label ?? BINDU_LABELS[state]}
      data-state={state}
      {...(motion === null ? {} : { 'data-motion': motion })}
      className={binduStyles({ state, breathe: motion === 'breathe', className })}
    >
      {/* The Bindu glyph's geometry (icons/glyphs/bindu.ts), drawn per state. */}
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        width={20}
        height={20}
        fill="none"
        stroke="currentColor"
        strokeWidth={ICON_STROKE_WIDTH}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle
          data-part="ring"
          cx="12"
          cy="12"
          r="9.5"
          strokeWidth={shape.ring === 'heavy' ? ICON_STROKE_WIDTH * 1.75 : ICON_STROKE_WIDTH}
          className={motion === 'ring' ? 'bindu-ring-pulse' : undefined}
        />
        <rect
          data-part="frame"
          x="7.5"
          y="7.5"
          width="9"
          height="9"
          rx="0.5"
          fill={shape.filled ? 'currentColor' : 'none'}
        />
        {shape.core === 0 ? null : (
          <circle
            data-part="core"
            cx="12"
            cy="12"
            r={shape.core}
            fill={shape.filled ? 'var(--color-bg)' : 'currentColor'}
            stroke="none"
            className={motion === 'core' ? 'bindu-core-pulse' : undefined}
          />
        )}
      </svg>
    </span>
  );
}
