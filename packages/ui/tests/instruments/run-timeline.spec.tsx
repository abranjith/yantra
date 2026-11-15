// @no-llm
/**
 * RunTimeline (FEAT-067 TASK-002): the engine's activity, virtualized, with
 * status as a glyph and a word.
 */

import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  RunTimeline,
  timelineRowLabel,
  type RunTimelineEntry,
} from '../../src/instruments/RunTimeline.js';
import { expectNoAxeViolations } from '../support/axe.js';
import { useFixedLayout } from '../support/layout.js';

useFixedLayout(800, 320);

const AT = '2026-11-14T10:00:00.000Z';

function tool(seq: number, overrides: Partial<Extract<RunTimelineEntry, { type: 'tool' }>> = {}) {
  return {
    type: 'tool',
    seq,
    tool: 'browser_fill',
    summary: 'fields: email',
    status: 'ok',
    result: 'ok',
    durationMs: 40,
    at: AT,
    ...overrides,
  } as const satisfies RunTimelineEntry;
}

const MIXED: readonly RunTimelineEntry[] = [
  tool(1, { status: 'running', result: null, durationMs: null }),
  tool(2, { status: 'error', result: 'error timeout' }),
  tool(3, { status: 'denied', result: 'denied' }),
  tool(4, { status: 'aborted', result: null }),
  {
    type: 'recovery',
    seq: 5,
    rung: 'steer',
    trigger: 'stalled',
    summary: 'steered to fill the remaining fields',
    at: AT,
  },
  { type: 'phase', seq: 6, phase: 'search', text: 'search duckduckgo: 6 results', at: AT },
  { type: 'step', seq: 7, kind: 'run_warning', text: 'warning: slow', tone: 'warn', at: AT },
];

function rows(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[data-seq]')];
}

describe('RunTimeline', () => {
  it('shows every status as a word beside its glyph, never color alone', () => {
    const { container } = render(<RunTimeline entries={MIXED} />);

    const words = rows(container).map(
      (row) => row.querySelector('[data-part="status"]')?.textContent,
    );
    expect(words).toEqual(['running', 'error', 'denied', 'aborted', 'steer', 'search', 'warning']);
    for (const row of rows(container)) {
      expect(row.querySelector('[data-part="status"] svg')).not.toBeNull();
    }
  });

  it('keeps rows in order with the newest at the bottom', () => {
    const { container } = render(<RunTimeline entries={MIXED} />);

    expect(rows(container).map((row) => Number(row.dataset.seq))).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('marks recovery steers and phases with their own row types', () => {
    const { container } = render(<RunTimeline entries={MIXED} />);

    expect(rows(container).map((row) => row.dataset.type)).toEqual([
      'tool',
      'tool',
      'tool',
      'tool',
      'recovery',
      'phase',
      'step',
    ]);
  });

  it('marks the current call in words', () => {
    const { container } = render(<RunTimeline entries={MIXED} currentSeq={1} />);

    const current = container.querySelector<HTMLElement>('[data-current="true"]');
    expect(current?.dataset.seq).toBe('1');
    expect(within(current!).getByText('current')).toBeDefined();
  });

  it('renders a bounded DOM for 2,000 rows', () => {
    const entries = Array.from({ length: 2_000 }, (_, index) => tool(index + 1));

    const { container } = render(<RunTimeline entries={entries} />);

    expect(rows(container).length).toBeGreaterThan(0);
    expect(rows(container).length).toBeLessThan(100);
  });

  it('renders untrusted text with markup as text', () => {
    const { container } = render(
      <RunTimeline
        entries={[tool(1, { summary: '<img src=x onerror=alert(1)>', result: '<b>bold</b>' })]}
      />,
    );

    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(screen.getByText(/<img src=x onerror=alert\(1\)>/u)).toBeDefined();
  });

  it('says when there is no activity yet', () => {
    render(<RunTimeline entries={[]} />);

    expect(screen.getByText('No engine activity yet.')).toBeDefined();
  });

  it('says how many earlier entries are only in the event log', () => {
    render(<RunTimeline entries={[tool(5)]} omitted={4} />);

    expect(screen.getByText('4 earlier entries are in the run’s event log.')).toBeDefined();
  });

  it('labels a row with its status word and text', () => {
    expect(timelineRowLabel(tool(1))).toBe('ok: browser_fill fields: email -> ok (40 ms)');
    expect(timelineRowLabel(MIXED[4]!)).toBe(
      'steer: recovery steer (stalled): steered to fill the remaining fields',
    );
  });

  it('has no axe violations', async () => {
    const { container } = render(<RunTimeline entries={MIXED} currentSeq={1} />);

    await expectNoAxeViolations(container);
  });
});
