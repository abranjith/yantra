// @no-llm
/**
 * CitationChip (FEAT-066 TASK-005/006): a labelled button that opens its
 * evidence in one press, with a tooltip preview.
 */

import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { CitationChip, citationLabel } from '../../src/instruments/CitationChip.js';
import { expectNoAxeViolations } from '../support/axe.js';

describe('CitationChip', () => {
  it('names a source chip "Source n" and shows [n]', () => {
    render(<CitationChip kind="source" id="3" onPress={() => undefined} />);
    const chip = screen.getByRole('button', { name: 'Source 3' });
    expect(chip.textContent).toBe('[3]');
  });

  it('names an action chip "Action An" and shows An', () => {
    render(<CitationChip kind="action" id="A2" onPress={() => undefined} />);
    expect(screen.getByRole('button', { name: 'Action A2' }).textContent).toBe('A2');
  });

  it('calls onPress once per click and on Enter', async () => {
    const onPress = vi.fn();
    render(<CitationChip kind="source" id="1" preview="example.com — Title" onPress={onPress} />);

    await userEvent.click(screen.getByRole('button', { name: 'Source 1' }));
    await userEvent.keyboard('{Enter}');

    expect(onPress).toHaveBeenCalledTimes(2);
  });

  it('shows its preview on keyboard focus', async () => {
    render(
      <>
        <button type="button">before</button>
        <CitationChip
          kind="source"
          id="1"
          preview="example.com — Title"
          onPress={() => undefined}
        />
      </>,
    );
    await userEvent.tab();
    await userEvent.tab();
    expect((await screen.findByRole('tooltip')).textContent).toBe('example.com — Title');
  });

  it('labels each kind', () => {
    expect(citationLabel('source', '12')).toBe('Source 12');
    expect(citationLabel('action', 'A1')).toBe('Action A1');
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <p>
        Claim <CitationChip kind="source" id="1" preview="p" onPress={() => undefined} />
        <CitationChip kind="action" id="A1" onPress={() => undefined} />
      </p>,
    );
    await expectNoAxeViolations(container);
  });
});
