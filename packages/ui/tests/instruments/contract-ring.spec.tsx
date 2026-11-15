// @no-llm
/**
 * ContractRing and the live RequirementList (FEAT-067 TASK-004).
 */

import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  ContractRing,
  arcPath,
  contractRingLabel,
  type RingSegment,
} from '../../src/instruments/ContractRing.js';
import { LiveRequirementList } from '../../src/instruments/RequirementList.js';
import { expectNoAxeViolations } from '../support/axe.js';

const FIVE: readonly RingSegment[] = [
  { id: 'fill', label: 'Fill the form', state: 'met' },
  { id: 'artifact:screenshot:viewport', label: 'Screenshot', state: 'advancing' },
  { id: 'effects.submit', label: 'Submit', state: 'pending' },
  { id: 'deliverable', label: 'Report', state: 'met' },
  { id: 'filter:price', label: 'Under $100', state: 'met' },
];

function segments(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[data-segment]')];
}

describe('ContractRing', () => {
  it('draws one segment per requirement, in requirement order', () => {
    const { container } = render(<ContractRing segments={FIVE} />);

    expect(segments(container).map((segment) => segment.dataset.segment)).toEqual(
      FIVE.map((segment) => segment.id),
    );
  });

  it('names the ring with a computed text alternative', () => {
    render(<ContractRing segments={FIVE} />);

    expect(screen.getByRole('img', { name: '3 of 5 requirements met' })).toBeDefined();
    expect(contractRingLabel([{ id: 'a', label: 'A', state: 'pending' }])).toBe(
      '0 of 1 requirement met',
    );
  });

  it('shows each state by pattern and glyph, not color alone', () => {
    const { container } = render(<ContractRing segments={FIVE} />);

    const byState = new Map(
      segments(container).map((segment) => [
        segment.dataset.state,
        {
          dash: segment.querySelector('path')?.getAttribute('stroke-dasharray'),
          glyphs: segment.querySelectorAll('circle, path').length,
        },
      ]),
    );
    expect(byState.get('met')?.dash).toBe('none');
    expect(byState.get('advancing')?.dash).toBe('7 4');
    expect(byState.get('pending')?.dash).toBe('1 5');
    // Arc plus a hollow, half-filled (disc and half) or filled glyph.
    expect(byState.get('pending')?.glyphs).toBe(2);
    expect(byState.get('advancing')?.glyphs).toBe(3);
    expect(byState.get('met')?.glyphs).toBe(2);
  });

  it('changes only the segment whose requirement changed', () => {
    const { container, rerender } = render(<ContractRing segments={FIVE} />);
    const before = segments(container).map((segment) => segment.outerHTML);

    rerender(
      <ContractRing
        segments={FIVE.map((segment) =>
          segment.id === 'effects.submit' ? { ...segment, state: 'met' } : segment,
        )}
      />,
    );

    const after = segments(container).map((segment) => segment.outerHTML);
    expect(after.filter((html, index) => html !== before[index])).toHaveLength(1);
    expect(screen.getByRole('img', { name: '4 of 5 requirements met' })).toBeDefined();
  });

  it('renders no ring for zero requirements', () => {
    const { container } = render(<ContractRing segments={[]} />);

    expect(container.innerHTML).toBe('');
  });

  it('draws a single requirement as a whole circle', () => {
    const { container } = render(<ContractRing segments={[FIVE[0]!]} />);

    expect(segments(container)).toHaveLength(1);
    expect(arcPath(0, 360)).toMatch(/A 38 38 0 1 1 .* A 38 38 0 1 1/u);
  });

  it('keeps twelve segments apart', () => {
    const twelve = Array.from({ length: 12 }, (_, index) => ({
      id: `r${String(index)}`,
      label: `R${String(index)}`,
      state: 'pending' as const,
    }));

    const { container } = render(<ContractRing segments={twelve} />);

    expect(segments(container)).toHaveLength(12);
    expect(screen.getByText('0/12')).toBeDefined();
  });

  it('has no axe violations', async () => {
    const { container } = render(<ContractRing segments={FIVE} />);

    await expectNoAxeViolations(container);
  });
});

describe('LiveRequirementList', () => {
  it('shows each live state word and its count', () => {
    render(
      <LiveRequirementList
        items={[
          {
            id: 'fill',
            kind: 'fill',
            label: 'Fill the form',
            state: 'advancing',
            done: 2,
            total: 5,
          },
          {
            id: 'deliverable',
            kind: 'deliverable',
            label: 'Report',
            state: 'pending',
            done: null,
            total: null,
          },
        ]}
      />,
    );

    const list = screen.getByRole('list', { name: 'Requirements' });
    const items = within(list).getAllByRole('listitem');
    expect(items.map((item) => item.querySelector('[data-part="status"]')?.textContent)).toEqual([
      'advancing',
      'pending',
    ]);
    expect(within(items[0]!).getByText('2 of 5')).toBeDefined();
    expect(items[1]!.textContent).not.toMatch(/of/u);
  });

  it('renders nothing without items', () => {
    const { container } = render(<LiveRequirementList items={[]} />);

    expect(container.innerHTML).toBe('');
  });
});
