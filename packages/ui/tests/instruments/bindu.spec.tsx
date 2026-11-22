// @no-llm
/**
 * The Bindu status mark (FEAT-065 TASK-011).
 */

import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  BINDU_LABELS,
  BINDU_MOTION,
  BINDU_SHAPES,
  BINDU_STATES,
  Bindu,
  type BinduState,
} from '../../src/instruments/bindu.js';
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

  /** What a sighted user sees with color and motion removed. */
  function silhouette(state: BinduState): string {
    const { container } = render(<Bindu state={state} />);
    const svg = container.querySelector('svg')!;
    const core = svg.querySelector('[data-part="core"]');
    return JSON.stringify({
      core: core?.getAttribute('r') ?? null,
      ring: svg.querySelector('[data-part="ring"]')?.getAttribute('stroke-width'),
      frame: svg.querySelector('[data-part="frame"]')?.getAttribute('fill'),
    });
  }

  it.each([
    ['shell', ['idle', 'live', 'attention']],
    ['engine', ['thinking', 'acting', 'needs_you', 'fulfilled']],
  ] as const)(
    'gives every %s state its own shape, so none depends on color (REV-012)',
    (_context, states) => {
      const shapes = states.map((state) => silhouette(state));
      expect(new Set(shapes).size).toBe(states.length);
    },
  );

  it('draws idle hollow, needs-you with a large core and fulfilled solid', () => {
    expect(JSON.parse(silhouette('idle'))).toMatchObject({ core: null, frame: 'none' });
    expect(JSON.parse(silhouette('needs_you'))).toMatchObject({ core: '3' });
    expect(JSON.parse(silhouette('fulfilled'))).toMatchObject({ frame: 'currentColor' });
    expect(BINDU_SHAPES.acting.ring).toBe('heavy');
  });

  it.each([
    ['thinking', 'breathe'],
    ['acting', 'ring'],
    ['needs_you', 'core'],
  ] as const)('gives %s its own motion (%s)', (state, motion) => {
    const { container } = render(<Bindu state={state} />);
    const mark = container.firstElementChild as HTMLElement;
    expect(mark.dataset.motion).toBe(motion);
    expect(mark.className.includes('bindu-pulse')).toBe(motion === 'breathe');
    expect(container.querySelector('.bindu-ring-pulse')?.getAttribute('data-part') ?? null).toBe(
      motion === 'ring' ? 'ring' : null,
    );
    expect(container.querySelector('.bindu-core-pulse')?.getAttribute('data-part') ?? null).toBe(
      motion === 'core' ? 'core' : null,
    );
  });

  it.each(BINDU_STATES.filter((state) => BINDU_MOTION[state] === null))(
    'keeps %s still',
    (state) => {
      const { container } = render(<Bindu state={state} />);
      expect((container.firstElementChild as HTMLElement).dataset.motion).toBeUndefined();
      expect(
        container.querySelector('.bindu-pulse, .bindu-ring-pulse, .bindu-core-pulse'),
      ).toBeNull();
    },
  );

  it('applies no animation class under reduced motion', () => {
    setMatchMedia({ 'prefers-reduced-motion: reduce': true });
    const { container } = render(
      <>
        <Bindu state="thinking" />
        <Bindu state="acting" />
        <Bindu state="needs_you" />
      </>,
    );
    expect(
      container.querySelector('.bindu-pulse, .bindu-ring-pulse, .bindu-core-pulse'),
    ).toBeNull();
    for (const node of container.querySelectorAll<HTMLElement>('[data-state]')) {
      expect(node.dataset.motion).toBeUndefined();
    }
  });

  it('stops moving when reduced motion turns on, keeping its shape', () => {
    const { container } = render(<Bindu state="acting" />);
    expect(container.querySelector('.bindu-ring-pulse')).not.toBeNull();

    act(() => {
      setMatchMedia({ 'prefers-reduced-motion: reduce': true });
    });

    expect(container.querySelector('.bindu-ring-pulse')).toBeNull();
    expect(container.querySelector('[data-part="ring"]')?.getAttribute('stroke-width')).toBe(
      String(BINDU_SHAPES.acting.ring === 'heavy' ? 1.75 * 1.75 : 1.75),
    );
  });

  it('names another outcome through its label', () => {
    render(<Bindu state="idle" label="Engine: partial" />);
    expect(screen.getByRole('img', { name: 'Engine: partial' })).toBeTruthy();
  });
});
