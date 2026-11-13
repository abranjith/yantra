// @no-llm
/**
 * The Bindu status mark (FEAT-065 TASK-011).
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { BINDU_LABELS, BINDU_STATES, Bindu } from '../../src/instruments/bindu.js';

describe('Bindu', () => {
  it('renders idle by default with an accessible name', () => {
    render(<Bindu />);
    const mark = screen.getByRole('img', { name: 'Yantra status: idle' });
    expect(mark.dataset.state).toBe('idle');
  });

  it.each(BINDU_STATES)('names the %s state, never by color alone', (state) => {
    render(<Bindu state={state} />);
    expect(screen.getByRole('img', { name: BINDU_LABELS[state] }).dataset.state).toBe(state);
  });

  it('uses semantic color utilities only', () => {
    const { container } = render(<Bindu state="attention" />);
    const className = container.firstElementChild?.className ?? '';
    expect(className).toContain('text-signal-needs-you');
    expect(className).not.toMatch(/#|rgb|oklch|-\d{3}\b/u);
  });

  it('hides the glyph itself from assistive technology', () => {
    const { container } = render(<Bindu />);
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('accepts a label override', () => {
    render(<Bindu label="Custom" />);
    expect(screen.getByRole('img', { name: 'Custom' })).toBeTruthy();
  });
});
