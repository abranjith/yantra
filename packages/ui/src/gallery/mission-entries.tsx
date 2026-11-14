/**
 * Gallery entries for the FEAT-067 Mission instruments: every state each one
 * can show. Deterministic data only, because the harness screenshots each
 * entry against a visual baseline.
 */

import type { ReactNode } from 'react';

import { BINDU_STATES, Bindu } from '../instruments/bindu.js';
import { BudgetGauges } from '../instruments/BudgetGauge.js';
import { CliTwin } from '../instruments/CliTwin.js';
import { ContractRing, type RingSegment } from '../instruments/ContractRing.js';
import { LiveRequirementList } from '../instruments/RequirementList.js';
import { RunStatusBanner } from '../instruments/RunStatusBanner.js';
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

const STATES = ['met', 'advancing', 'pending'] as const;

function ring(count: number): RingSegment[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `requirement-${String(index)}`,
    label: `Requirement ${String(index + 1)}`,
    state: STATES[index % STATES.length]!,
  }));
}

function ContractSheet(): ReactNode {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-6">
        <ContractRing segments={ring(1)} />
        <ContractRing segments={ring(5)} />
        <ContractRing segments={ring(12)} />
        <ContractRing
          segments={ring(5).map((segment) => ({ ...segment, state: 'met' as const }))}
        />
        <span className="text-caption text-ink-2">0 requirements: no ring</span>
        <ContractRing segments={[]} />
      </div>
      <LiveRequirementList
        items={[
          {
            id: 'fill',
            kind: 'fill',
            label: 'Fill the contact form',
            state: 'advancing',
            done: 2,
            total: 5,
          },
          {
            id: 'artifact:screenshot:viewport',
            kind: 'artifact',
            label: 'Screenshot of the page',
            state: 'pending',
            done: null,
            total: null,
          },
          {
            id: 'deliverable',
            kind: 'deliverable',
            label: 'Report what was done',
            state: 'met',
            done: null,
            total: null,
          },
        ]}
      />
    </div>
  );
}

const noop = (): void => undefined;

function StatusSheet(): ReactNode {
  return (
    <div className="flex max-w-2xl flex-col gap-3">
      <RunStatusBanner
        word="queued"
        detail="Queued: number 1 in line; it starts when a slot is free (at most two runs at once)."
        actions={[{ id: 'cancel', label: 'Cancel', onPress: noop }]}
      />
      <RunStatusBanner
        word="running"
        detail="Running."
        actions={[{ id: 'stop', label: 'Stop', onPress: noop }]}
      />
      <RunStatusBanner
        word="waiting for you"
        detail="Submit the order form."
        tone="attention"
        actions={[{ id: 'open', label: 'Open the run result', onPress: noop }]}
      />
      <RunStatusBanner
        word="start outcome unknown"
        detail="Yantra cannot tell whether this run started. It may already have run."
        tone="caution"
        actions={[
          { id: 'start', label: 'Start anyway', onPress: noop, tone: 'danger' },
          { id: 'discard', label: 'Discard', onPress: noop },
        ]}
      />
      <RunStatusBanner word="stopping" detail="Stopping…" />
      <RunStatusBanner word="finished" detail="The run ended fulfilled." tone="fulfilled" />
      <RunStatusBanner word="finished" detail="The run ended failed." tone="failed" />
    </div>
  );
}

function TwinSheet(): ReactNode {
  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <CliTwin
        defaultShell="powershell"
        formatted={{
          posix: { text: "yantra research 'q'\\''s $x `y` 100%' --no-llm" },
          powershell: { text: "yantra research 'q''s $x `y` 100%' --no-llm" },
          cmd: {
            unavailable:
              'cmd cannot run this command: argument 2 contains a percent sign, which cmd expands as a variable',
          },
        }}
      />
      <CliTwin
        defaultShell="cmd"
        label="This run"
        badge="Reconstructed"
        formatted={{
          posix: { text: "yantra ask 'electric vehicles' --no-llm" },
          powershell: { text: "yantra ask 'electric vehicles' --no-llm" },
          cmd: { unavailable: 'cmd cannot run this command: argument 2 contains a line break' },
        }}
      />
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
    id: 'instrument-contract-ring',
    title: 'ContractRing and live RequirementList',
    primitive: null,
    render: () => <ContractSheet />,
    interactive: false,
  },
  {
    id: 'instrument-cli-twin',
    title: 'CliTwin',
    primitive: null,
    render: () => <TwinSheet />,
    interactive: true,
  },
  {
    id: 'instrument-run-status',
    title: 'RunStatusBanner',
    primitive: null,
    render: () => <StatusSheet />,
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
