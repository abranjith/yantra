/**
 * What the top-bar Bindu says about a run (FEAT-067 TASK-003).
 *
 * - fulfilled: the run ended fulfilled; any other ending says its outcome
 *   word (`Engine: partial`, `Engine: interrupted, failed`).
 * - needs you: a wait for a person is open, or the start needs a decision
 *   (needs review, start outcome unknown).
 * - acting / thinking: from the tool lifecycle and the deterministic phases.
 * - stalled: thinking, named `Engine: stalled`.
 */

import type { ShellBindu } from '../../app/shell/bindu-store.js';
import { engineState, type CockpitState } from '../live/cockpit-state.js';

/** Displayed states that need the user's decision before the run can go on. */
const DECISIONS: ReadonlySet<string> = new Set([
  'needs_review',
  'start_unknown',
  'waiting_for_you',
]);

/** The Bindu for `state`, given the displayed state's kind when known. */
export function cockpitBindu(state: CockpitState, displayedKind?: string): ShellBindu {
  const outcome = state.outcome;
  if (outcome !== null) {
    if (outcome.executionState === 'interrupted') {
      return { state: 'idle', label: `Engine: interrupted, ${outcome.outcome}` };
    }
    return outcome.outcome === 'fulfilled'
      ? { state: 'fulfilled' }
      : { state: 'idle', label: `Engine: ${outcome.outcome}` };
  }
  if (
    state.pendingInterventions.length > 0 ||
    (displayedKind !== undefined && DECISIONS.has(displayedKind))
  ) {
    return { state: 'needs_you' };
  }
  switch (engineState(state)) {
    case 'acting':
      return { state: 'acting' };
    case 'stalled':
      return { state: 'thinking', label: 'Engine: stalled' };
    case 'thinking':
      return { state: 'thinking' };
    case 'idle':
      return { state: 'live', label: 'Engine: starting' };
  }
}
