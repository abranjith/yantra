/**
 * Gallery entries for the FEAT-067 Mission instruments: every state each one
 * can show. Deterministic data only, because the harness screenshots each
 * entry against a visual baseline.
 */

import type { ReactNode } from 'react';

import { BINDU_STATES, Bindu } from '../instruments/bindu.js';
import { BudgetGauges } from '../instruments/BudgetGauge.js';
import { RunTimeline, type RunTimelineEntry } from '../instruments/RunTimeline.js';
import { TruncatedText } from '../instruments/TruncatedText.js';

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

function BinduSheet(): ReactNode {
  return (
    <ul className="flex flex-wrap items-center gap-4">
      {BINDU_STATES.map((state) => (
        <li key={state} className="flex items-center gap-2">
          <Bindu state={state} />
          <span className="type-engine text-ink-2">{state}</span>
        </li>
      ))}
      <li className="flex items-center gap-2">
        <Bindu state="idle" label="Engine: partial" />
        <span className="type-engine text-ink-2">partial</span>
      </li>
    </ul>
  );
}

function BudgetSheet(): ReactNode {
  return (
    <div className="flex max-w-xl flex-col gap-6">
      <BudgetGauges
        dimensions={[
          { name: 'elapsed', used: 95_000, limit: 900_000, unit: 'ms' },
          { name: 'tool_calls', used: 12, limit: 40, unit: 'count' },
          { name: 'hosts', used: 3, limit: 3, unit: 'count' },
          { name: 'captures', used: 2, limit: null, unit: 'count' },
        ]}
      />
      <div className="max-w-xs">
        <TruncatedText text="find quiet laptops for long flights under $1,200 with at least 14 hours of battery" />
      </div>
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
  {
    id: 'instrument-bindu-states',
    title: 'Bindu run states',
    primitive: null,
    render: () => <BinduSheet />,
    interactive: false,
  },
  {
    id: 'instrument-budget-gauge',
    title: 'BudgetGauge and TruncatedText',
    primitive: null,
    render: () => <BudgetSheet />,
    interactive: true,
  },
];
