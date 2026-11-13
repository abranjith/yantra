import type { LedgerDisplayedState, TaskOutcome } from '@yantra/protocol';
import type { ReactNode } from 'react';

import { Icon } from '../icons/Icon.js';
import type { IconName } from '../icons/registry.js';
import { cn, tv } from '../lib/cn.js';

/**
 * OutcomeBadge (FEAT-066): how a run ended, in the CLI's exact words.
 *
 * - The text is the protocol word verbatim: `${status} ${taskOutcome}` when
 *   the run recorded an outcome, else the status word, exactly the segment
 *   `yantra list` prints.
 * - `interrupted` (FEAT-064) is a separate execution-state chip.
 * - An unfinished run shows its displayed state (plan §8) instead.
 *
 * Color is never the only signal: every tone pairs with an icon and text.
 */

/** The outcome words in the order the protocol lists them. */
export const OUTCOME_WORDS: readonly TaskOutcome[] = [
  'fulfilled',
  'partial',
  'handoff',
  'failed',
  'aborted',
];

/** How each displayed state reads (plan §8). */
export const DISPLAYED_STATE_LABELS: Readonly<Record<LedgerDisplayedState, string>> = {
  queued: 'queued',
  starting: 'starting',
  running: 'running',
  waiting_for_you: 'waiting for you',
  needs_review: 'needs review',
  start_outcome_unknown: 'start outcome unknown',
  worker_not_responding: 'worker not responding',
  unknown_owner: 'status unknown',
};

type Tone = 'fulfilled' | 'caution' | 'failed' | 'neutral' | 'attention';

const OUTCOME_TONE: Readonly<Record<TaskOutcome, Tone>> = {
  fulfilled: 'fulfilled',
  partial: 'caution',
  handoff: 'caution',
  failed: 'failed',
  aborted: 'neutral',
};

const OUTCOME_ICON: Readonly<Record<TaskOutcome, IconName>> = {
  fulfilled: 'outcome.fulfilled',
  partial: 'outcome.partial',
  handoff: 'glyph.handoff',
  failed: 'outcome.failed',
  aborted: 'outcome.aborted',
};

const STATE_TONE: Readonly<Record<LedgerDisplayedState, Tone>> = {
  queued: 'neutral',
  starting: 'neutral',
  running: 'neutral',
  waiting_for_you: 'attention',
  needs_review: 'attention',
  start_outcome_unknown: 'caution',
  worker_not_responding: 'caution',
  unknown_owner: 'caution',
};

const STATE_ICON: Readonly<Record<LedgerDisplayedState, IconName>> = {
  queued: 'status.info',
  starting: 'glyph.bindu',
  running: 'glyph.bindu',
  waiting_for_you: 'status.needsYou',
  needs_review: 'status.needsYou',
  start_outcome_unknown: 'status.info',
  worker_not_responding: 'status.info',
  unknown_owner: 'status.info',
};

export const outcomeBadgeStyles = tv({
  base: 'inline-flex items-center gap-1 rounded-chip border px-2 py-0.5 text-caption font-semibold whitespace-nowrap',
  variants: {
    tone: {
      fulfilled: 'border-signal-fulfilled bg-surface text-signal-fulfilled-ink',
      caution: 'border-signal-partial bg-surface text-signal-partial-ink',
      failed: 'border-signal-failed bg-surface text-signal-failed-ink',
      attention: 'border-signal-needs-you bg-surface text-signal-needs-you-ink',
      neutral: 'border-rule bg-sunken text-ink-2',
    },
  },
  defaultVariants: { tone: 'neutral' },
});

export interface OutcomeBadgeProps {
  /** The manifest or history status word, exactly as the CLI prints it. */
  readonly status: string;
  readonly taskOutcome?: TaskOutcome | undefined;
  readonly executionState?: 'interrupted' | undefined;
  /** Set for a run that has not ended; it replaces the outcome text. */
  readonly displayedState?: LedgerDisplayedState | undefined;
  readonly className?: string;
}

/** The badge text: the outcome segment `yantra list` prints. */
export function outcomeText(status: string, taskOutcome: TaskOutcome | undefined): string {
  return taskOutcome === undefined ? status : `${status} ${taskOutcome}`;
}

/** See the module comment. */
export function OutcomeBadge({
  status,
  taskOutcome,
  executionState,
  displayedState,
  className,
}: OutcomeBadgeProps): ReactNode {
  const tone: Tone =
    displayedState !== undefined
      ? STATE_TONE[displayedState]
      : taskOutcome !== undefined
        ? OUTCOME_TONE[taskOutcome]
        : 'neutral';
  const icon: IconName =
    displayedState !== undefined
      ? STATE_ICON[displayedState]
      : taskOutcome !== undefined
        ? OUTCOME_ICON[taskOutcome]
        : 'status.info';
  const text =
    displayedState !== undefined
      ? DISPLAYED_STATE_LABELS[displayedState]
      : outcomeText(status, taskOutcome);
  return (
    <span className={cn('inline-flex items-center gap-1', className)}>
      <span
        data-part="outcome"
        data-tone={tone}
        {...(taskOutcome === undefined ? {} : { 'data-outcome': taskOutcome })}
        className={outcomeBadgeStyles({ tone })}
      >
        <Icon name={icon} size={16} />
        <span data-part="text">{text}</span>
      </span>
      {executionState === 'interrupted' ? (
        <span data-part="execution-state" className={outcomeBadgeStyles({ tone: 'caution' })}>
          <Icon name="status.info" size={16} />
          <span data-part="text">interrupted</span>
        </span>
      ) : null}
    </span>
  );
}
