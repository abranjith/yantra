/**
 * Gallery entries for the FEAT-066 instruments: every state each one can show,
 * including the empty, legacy and protected states. Deterministic data only,
 * because the harness screenshots each entry against a visual baseline.
 */

import type { ReactNode } from 'react';

import { CaptureGallery, type CaptureItem } from '../instruments/CaptureGallery.js';
import { CitationChip } from '../instruments/CitationChip.js';
import { ConditionTable } from '../instruments/ConditionTable.js';
import {
  DISPLAYED_STATE_LABELS,
  OUTCOME_WORDS,
  OutcomeBadge,
} from '../instruments/OutcomeBadge.js';
import { RequirementList } from '../instruments/RequirementList.js';
import { SafeMarkdown, type CitationContext } from '../instruments/SafeMarkdown.js';

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

const NOOP = (): void => undefined;

const GALLERY_CITATIONS: CitationContext = {
  resolves: (ref) => (ref.kind === 'source' ? ref.n <= 2 : true),
  render: (ref) => (
    <CitationChip
      kind={ref.kind}
      id={ref.kind === 'source' ? String(ref.n) : ref.id}
      preview="source-1.example.com — Source 1"
      onPress={NOOP}
    />
  ),
};

function CitationSheet(): ReactNode {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-ink">
        A cited claim
        <CitationChip kind="source" id="1" preview="example.com — Title" onPress={NOOP} />
        and an action
        <CitationChip kind="action" id="A2" preview="fill — Email" onPress={NOOP} />
      </p>
      <SafeMarkdown citations={GALLERY_CITATIONS}>
        {
          '**Markdown** with a resolving chip [1], an unresolved token [9], an action [A1], a [safe link](https://example.com) and an image as alt text: ![a chart](https://example.com/c.png)'
        }
      </SafeMarkdown>
    </div>
  );
}

function RequirementsSheet(): ReactNode {
  return (
    <div className="flex flex-col gap-6">
      <RequirementList
        requirements={[
          {
            id: 'deliverable',
            label: 'Save the confirmation',
            status: 'met',
            reason: null,
            declared_in: 1,
          },
          {
            id: 'fill',
            label: 'Fill every eligible field',
            status: 'unmet',
            reason: 'One field was left empty.',
            declared_in: 1,
            exemptions: [{ label: 'Upload ID', reason: 'file_input' }],
            exempt_overflow: 2,
          },
          {
            id: 'effects.submit',
            label: 'Submit',
            status: 'not_applicable',
            reason: null,
            declared_in: null,
          },
        ]}
      />
      <ConditionTable
        constraints={[
          { name: 'price', value: 'under $500', status: 'verified', citations: [1] },
          { name: 'brand', value: 'any', status: 'unverified', citations: [] },
          { name: 'range', value: 'over 60 km', status: 'violated', citations: [2] },
        ]}
      />
      <RequirementList requirements={[]} />
    </div>
  );
}

const CAPTURES: readonly CaptureItem[] = [
  {
    path: 'screenshots/capture-1-aaaaaaaaaaaa-p1.png',
    bytes: 1_000,
    width: 800,
    height: 600,
    part: 1,
    parts: 2,
    complete: false,
    labels: ['truncated'],
  },
  {
    path: 'screenshots/capture-1-aaaaaaaaaaaa-p2.png',
    bytes: 1_000,
    width: 800,
    height: 600,
    part: 2,
    parts: 2,
    complete: false,
    labels: ['truncated'],
  },
  {
    path: 'captures/huge.png',
    bytes: 30 * 1024 * 1024,
    width: null,
    height: null,
    sentToModel: false,
  },
];

function CaptureSheet(): ReactNode {
  return (
    <div className="flex flex-col gap-6">
      <CaptureGallery
        items={CAPTURES}
        renderImage={(item) => (
          <span className="flex h-24 items-center justify-center rounded-chip bg-sunken text-ink-2">
            {item.width}×{item.height}
          </span>
        )}
        renderOversize={() => (
          <span className="type-engine text-ink-2">yantra open … --artifact dir</span>
        )}
      />
      <CaptureGallery items={[]} renderImage={() => null} />
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
  {
    id: 'instrument-citations',
    title: 'CitationChip and SafeMarkdown',
    primitive: null,
    render: () => <CitationSheet />,
    interactive: true,
  },
  {
    id: 'instrument-requirements',
    title: 'RequirementList and ConditionTable',
    primitive: null,
    render: () => <RequirementsSheet />,
    interactive: false,
  },
  {
    id: 'instrument-capture-gallery',
    title: 'CaptureGallery',
    primitive: null,
    render: () => <CaptureSheet />,
    interactive: false,
  },
];
