/**
 * The cockpit's top bar (FEAT-067 TASK-003): mode, goal, elapsed time and
 * budgets, with the Stop control (TASK-008) at the end. It also drives the
 * app's top-bar Bindu while mounted.
 *
 * - Mode is the CLI command word, verbatim.
 * - The goal comes from `goal_echo` (already redacted by the run), in the
 *   user's plain voice, cut to one line with its full text in a tooltip.
 * - Elapsed time ticks once per second from the run's start and freezes at
 *   its outcome.
 * - One BudgetGauge per budget the latest `budget_snapshot` carries; none
 *   when the run reports no budgets.
 */

import { BudgetGauges, TruncatedText } from '@yantra/ui';
import type { ReactNode } from 'react';

import { useDriveBindu } from '../../app/shell/bindu-store.js';
import type { CockpitMode, CockpitState } from '../live/cockpit-state.js';
import { formatElapsed, useElapsed } from '../live/tick-clock.js';

import { cockpitBindu } from './bindu-state.js';

export interface CockpitTopBarProps {
  readonly state: CockpitState;
  /** The command word when the route knows it better than the stream. */
  readonly mode?: CockpitMode;
  /** The displayed state's kind, for the Bindu (TASK-005). */
  readonly displayedKind?: string;
  /** The Stop control (TASK-008). */
  readonly stop?: ReactNode;
}

/** Elapsed time as text, frozen at the outcome. */
export function Elapsed({
  startedAt,
  endedAt,
}: {
  readonly startedAt: string | null;
  readonly endedAt: string | null;
}): ReactNode {
  const ms = useElapsed(startedAt, endedAt);
  return (
    <span className="flex items-baseline gap-1" data-part="elapsed">
      <span className="type-label text-ink-2">Elapsed</span>
      <span className="type-engine text-ink">{ms === null ? '—' : formatElapsed(ms)}</span>
    </span>
  );
}

/** See the module comment. */
export function CockpitTopBar({
  state,
  mode: knownMode,
  displayedKind,
  stop,
}: CockpitTopBarProps): ReactNode {
  useDriveBindu(cockpitBindu(state, displayedKind));
  const mode = knownMode ?? state.mode;
  return (
    <div data-instrument="top_bar" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="flex items-baseline gap-1">
          <span className="type-label text-ink-2">Mode</span>
          <span className="type-engine text-ink" data-part="mode">
            {mode === 'other' ? '—' : mode}
          </span>
        </span>
        <span className="flex min-w-0 flex-1 items-baseline gap-1" data-part="goal">
          <span className="type-label shrink-0 text-ink-2">Goal</span>
          {state.goal === null ? (
            <span className="text-ink-2">Waiting for the run to start…</span>
          ) : (
            <TruncatedText text={state.goal} className="type-body text-ink" />
          )}
        </span>
        <Elapsed startedAt={state.startedAt} endedAt={state.outcome?.endedAt ?? null} />
        {stop}
      </div>
      {state.budgets === null ? null : (
        <div data-instrument="budgets">
          <BudgetGauges dimensions={state.budgets.dimensions} />
        </div>
      )}
    </div>
  );
}
