/**
 * Gallery entries for the FEAT-067 Mission instruments: every state each one
 * can show. Deterministic data only, because the harness screenshots each
 * entry against a visual baseline.
 */

import type { ReactNode } from 'react';

import { RunTimeline, type RunTimelineEntry } from '../instruments/RunTimeline.js';

import type { GalleryEntry } from './entries.js';

const AT = '2026-11-01T00:00:00.000Z';

const TIMELINE: readonly RunTimelineEntry[] = [
  {
    type: 'phase',
    seq: 1,
    phase: 'search',
    text: 'search duckduckgo: 6 results for "quiet laptops"',
    at: AT,
  },
  { type: 'phase', seq: 2, phase: 'fetch', text: 'fetch ok https://example.test/review', at: AT },
  {
    type: 'tool',
    seq: 3,
    tool: 'browser_fill',
    summary: 'fields: email, name',
    status: 'ok',
    result: 'ok',
    durationMs: 120,
    at: AT,
  },
  {
    type: 'tool',
    seq: 4,
    tool: 'browser_click',
    summary: 'target: Submit',
    status: 'denied',
    result: 'denied',
    durationMs: 4,
    at: AT,
  },
  {
    type: 'recovery',
    seq: 5,
    rung: 'steer',
    trigger: 'stalled',
    summary: 'steered to fill the remaining fields',
    at: AT,
  },
  {
    type: 'tool',
    seq: 6,
    tool: 'web_fetch',
    summary: 'url: https://example.test/a',
    status: 'error',
    result: 'error fetch_timeout',
    durationMs: 8_000,
    at: AT,
  },
  {
    type: 'step',
    seq: 7,
    kind: 'run_warning',
    text: 'warning: search is slow',
    tone: 'warn',
    at: AT,
  },
  {
    type: 'tool',
    seq: 8,
    tool: 'browser_observe',
    summary: '',
    status: 'running',
    result: null,
    durationMs: null,
    at: AT,
  },
];

function TimelineSheet(): ReactNode {
  return (
    <div className="flex flex-col gap-6">
      <RunTimeline
        entries={TIMELINE}
        currentSeq={8}
        height="18rem"
        aria-label="Engine timeline: mixed"
      />
      <RunTimeline
        entries={TIMELINE.slice(0, 3)}
        omitted={1_250}
        height="8rem"
        aria-label="Engine timeline: older rows omitted"
      />
      <RunTimeline entries={[]} height="6rem" aria-label="Engine timeline: empty" />
    </div>
  );
}

/** The Mission instruments' gallery entries. */
export const MISSION_ENTRIES: readonly GalleryEntry[] = [
  {
    id: 'instrument-run-timeline',
    title: 'RunTimeline',
    primitive: null,
    render: () => <TimelineSheet />,
    interactive: true,
  },
];
