// @no-llm
/**
 * RequirementList and ConditionTable (FEAT-066 TASK-005): status words
 * verbatim, reasons, exemptions with "+N more", citations, and axe.
 */

import { render, screen, within } from '@testing-library/react';
import type { BriefConstraint, BriefRequirement } from '@yantra/protocol';
import { describe, expect, it } from 'vitest';

import { ConditionTable } from '../../src/instruments/ConditionTable.js';
import { RequirementList, StatusWord } from '../../src/instruments/RequirementList.js';
import { expectNoAxeViolations } from '../support/axe.js';

const REQUIREMENTS: BriefRequirement[] = [
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
    reason: 'Two fields were left empty.',
    declared_in: 1,
    exemptions: [
      { label: 'Upload ID', reason: 'file_input' },
      { label: 'Captcha', reason: 'human_verification' },
    ],
    exempt_overflow: 3,
  },
  {
    id: 'effects.submit',
    label: 'Submit',
    status: 'not_applicable',
    reason: null,
    declared_in: null,
  },
];

const CONSTRAINTS: BriefConstraint[] = [
  { name: 'price', value: 'under $500', status: 'verified', citations: [1, 2] },
  { name: 'brand', value: 'any', status: 'unverified', citations: [] },
  { name: 'range', value: '> 60 km', status: 'violated', citations: [3] },
];

describe('RequirementList', () => {
  it('shows each status word verbatim beside its label', () => {
    const { container } = render(<RequirementList requirements={REQUIREMENTS} />);
    const words = [...container.querySelectorAll('[data-part="status"]')].map(
      (node) => node.textContent,
    );
    expect(words).toEqual(['met', 'unmet', 'not_applicable']);
    expect(screen.getByText('Fill every eligible field')).toBeTruthy();
    expect(screen.getByText('Two fields were left empty.')).toBeTruthy();
  });

  it('lists exemptions and counts the overflow as "+N more"', () => {
    render(<RequirementList requirements={REQUIREMENTS} />);
    expect(screen.getByText('Upload ID: file_input')).toBeTruthy();
    expect(screen.getByText('Captcha: human_verification')).toBeTruthy();
    expect(screen.getByText('+3 more')).toBeTruthy();
  });

  it('renders nothing for no requirements', () => {
    const { container } = render(<RequirementList requirements={[]} />);
    expect(container.innerHTML).toBe('');
  });

  it.each([
    ['met', 'fulfilled'],
    ['verified', 'fulfilled'],
    ['unmet', 'failed'],
    ['violated', 'failed'],
    ['not_applicable', 'neutral'],
    ['unverified', 'neutral'],
  ])('gives %s a %s tone with an icon', (word, tone) => {
    const { container } = render(<StatusWord word={word} />);
    const badge = container.querySelector('[data-part="status"]')!;
    expect(badge.className).toContain(
      { fulfilled: 'signal-fulfilled', failed: 'signal-failed', neutral: 'text-ink-2' }[tone],
    );
    expect(badge.querySelector('svg')).not.toBeNull();
  });

  it('has no axe violations', async () => {
    const { container } = render(<RequirementList requirements={REQUIREMENTS} />);
    await expectNoAxeViolations(container);
  });
});

describe('ConditionTable', () => {
  it('shows name, value, status word and citations per condition', () => {
    render(
      <ConditionTable
        constraints={CONSTRAINTS}
        renderCitations={(citations) =>
          citations.map((n) => <button key={n} type="button">{`Source ${String(n)}`}</button>)
        }
      />,
    );
    const table = screen.getByRole('table', { name: 'Conditions' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((row) => within(row).getByRole('rowheader').textContent)).toEqual([
      'price',
      'brand',
      'range',
    ]);
    expect(within(rows[0]!).getByText('under $500')).toBeTruthy();
    expect(within(rows[0]!).getByText('verified')).toBeTruthy();
    expect(
      within(rows[0]!)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Source 1', 'Source 2']);
    expect(within(rows[1]!).getByText('none')).toBeTruthy();
    expect(within(rows[2]!).getByText('violated')).toBeTruthy();
  });

  it('falls back to literal [n] without a chip renderer', () => {
    render(<ConditionTable constraints={CONSTRAINTS.slice(0, 1)} />);
    expect(screen.getByText('[1] [2]')).toBeTruthy();
  });

  it('renders nothing for no conditions', () => {
    const { container } = render(<ConditionTable constraints={[]} />);
    expect(container.innerHTML).toBe('');
  });

  it('has no axe violations', async () => {
    const { container } = render(<ConditionTable constraints={CONSTRAINTS} />);
    await expectNoAxeViolations(container);
  });
});
