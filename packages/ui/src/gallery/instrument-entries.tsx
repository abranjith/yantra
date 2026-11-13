/**
 * Gallery entries for the FEAT-066 instruments: every state each one can show,
 * including the empty, legacy and protected states. Deterministic data only,
 * because the harness screenshots each entry against a visual baseline.
 */

import type { ReactNode } from 'react';

import {
  DISPLAYED_STATE_LABELS,
  OUTCOME_WORDS,
  OutcomeBadge,
} from '../instruments/OutcomeBadge.js';

import type { GalleryEntry } from './entries.js';

function OutcomeBadgeSheet(): ReactNode {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        {OUTCOME_WORDS.map((word) => (
          <OutcomeBadge key={word} status="completed" taskOutcome={word} />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <OutcomeBadge status="completed" />
        <OutcomeBadge status="failed" taskOutcome="failed" executionState="interrupted" />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {Object.keys(DISPLAYED_STATE_LABELS).map((state) => (
          <OutcomeBadge
            key={state}
            status="running"
            displayedState={state as keyof typeof DISPLAYED_STATE_LABELS}
          />
        ))}
      </div>
    </div>
  );
}

/** The instrument entries, appended to the gallery. */
export const INSTRUMENT_ENTRIES: readonly GalleryEntry[] = [
  {
    id: 'instrument-outcome-badge',
    title: 'OutcomeBadge',
    primitive: null,
    render: () => <OutcomeBadgeSheet />,
    interactive: false,
  },
];
