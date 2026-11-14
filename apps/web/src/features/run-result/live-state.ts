/**
 * How a run that has not ended is shown (FEAT-066): the view's live flag as a
 * displayed state. An owner that cannot be verified reads `status unknown`,
 * never `running` (memory -> Architecture).
 */

import type { LedgerDisplayedState, RunResultView } from '@yantra/protocol';

const LIVE_STATE: Readonly<
  Record<NonNullable<RunResultView['live']>['state'], LedgerDisplayedState>
> = {
  running: 'running',
  waiting_for_you: 'waiting_for_you',
  unknown_owner: 'unknown_owner',
};

/** The displayed state of a live run, or undefined once it has ended. */
export function liveDisplayedState(view: RunResultView): LedgerDisplayedState | undefined {
  return view.live === null ? undefined : LIVE_STATE[view.live.state];
}
