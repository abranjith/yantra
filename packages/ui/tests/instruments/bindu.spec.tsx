// @no-llm
/**
 * The Bindu status mark (FEAT-065 TASK-011).
 */

import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { BINDU_LABELS, BINDU_STATES, Bindu } from '../../src/instruments/bindu.js';
import { setMatchMedia } from '../support/match-media.js';

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

  it.each([
    ['thinking', 'Engine: thinking'],
    ['acting', 'Engine: acting'],
    ['needs_you', 'Engine: needs you'],
    ['fulfilled', 'Engine: fulfilled'],
  ] as const)('names the run state %s as "%s"', (state, name) => {
    render(<Bindu state={state} />);
    expect(screen.getByRole('img', { name }).dataset.state).toBe(state);
  });

  it('breathes while thinking or acting', () => {
    const { container } = render(
      <>
        <Bindu state="thinking" />
        <Bindu state="acting" />
        <Bindu state="fulfilled" />
      </>,
    );
    const classes = [...container.querySelectorAll('[data-state]')].map((node) =>
      node.className.includes('bindu-pulse'),
    );
    expect(classes).toEqual([true, true, false]);
  });

  it('applies no animation class under reduced motion', () => {
    setMatchMedia({ 'prefers-reduced-motion: reduce': true });
    const { container } = render(
      <>
        <Bindu state="thinking" />
        <Bindu state="acting" />
      </>,
    );
    for (const node of container.querySelectorAll('[data-state]')) {
      expect(node.className).not.toContain('bindu-pulse');
    }
  });

  it('stops breathing when reduced motion turns on', () => {
    const { container } = render(<Bindu state="acting" />);
    expect(container.firstElementChild?.className).toContain('bindu-pulse');

    act(() => {
      setMatchMedia({ 'prefers-reduced-motion: reduce': true });
    });

    expect(container.firstElementChild?.className).not.toContain('bindu-pulse');
  });

  it('names another outcome through its label', () => {
    render(<Bindu state="idle" label="Engine: partial" />);
    expect(screen.getByRole('img', { name: 'Engine: partial' })).toBeTruthy();
  });
});
