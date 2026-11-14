/**
 * The cockpit's one polite live region (FEAT-067 TASK-006). It speaks what
 * {@link announcementsFor} finds worth saying, at most once every 2 s, and
 * never moves focus.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';

import {
  announcementsFor,
  createAnnouncementQueue,
  type AnnounceClock,
  type AnnounceView,
} from '../live/announcer.js';
import type { CockpitState } from '../live/cockpit-state.js';
import type { DisplayedKind } from '../live/displayed-state.js';

/** The slice of the cockpit the announcer compares. */
export function announceView(state: CockpitState, kind: DisplayedKind): AnnounceView {
  const outcome = state.outcome;
  return {
    kind,
    contract: state.contract,
    interventions: state.pendingInterventions.map((item) => ({
      id: item.interventionId,
      summary: item.summary,
    })),
    met: state.requirements.filter((item) => item.state === 'met').length,
    total: state.requirements.length,
    outcome:
      outcome === null
        ? null
        : outcome.executionState === 'interrupted'
          ? `interrupted · ${outcome.outcome}`
          : outcome.outcome,
  };
}

export interface CockpitAnnouncerProps {
  readonly view: AnnounceView;
  readonly clock?: AnnounceClock;
  /** Called after each spoken text (the finish transition waits for the outcome's). */
  readonly onSpoken?: (text: string) => void;
}

/** See the module comment. */
export function CockpitAnnouncer({ view, clock, onSpoken }: CockpitAnnouncerProps): ReactNode {
  const [text, setText] = useState('');
  const spoken = useRef(onSpoken);
  useEffect(() => {
    spoken.current = onSpoken;
  }, [onSpoken]);
  const [queue] = useState(() =>
    createAnnouncementQueue((next) => {
      setText(next);
      spoken.current?.(next);
    }, clock),
  );
  const previous = useRef<AnnounceView | null>(null);

  useEffect(() => {
    const items = announcementsFor(previous.current, view);
    previous.current = view;
    queue.push(items);
  }, [queue, view]);

  useEffect(
    () => () => {
      queue.dispose();
    },
    [queue],
  );

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="sr-only"
      data-part="announcer"
    >
      {text}
    </div>
  );
}
