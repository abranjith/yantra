// @no-llm
/**
 * RunStatusBanner (FEAT-067 TASK-005): the displayed state with its actions.
 */

import { render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { RunStatusBanner } from '../../src/instruments/RunStatusBanner.js';
import { expectNoAxeViolations } from '../support/axe.js';

describe('RunStatusBanner', () => {
  it('shows the state word with an icon and its detail', () => {
    render(
      <RunStatusBanner word="waiting for you" detail="Submit the order form." tone="attention" />,
    );

    const region = screen.getByRole('region', { name: 'Run status: waiting for you' });
    const word = region.querySelector('[data-part="word"]')!;
    expect(word.textContent).toBe('waiting for you');
    expect(word.querySelector('svg')).not.toBeNull();
    expect(within(region).getByText('Submit the order form.')).toBeDefined();
  });

  it('runs each action once per press, reachable by keyboard in order', async () => {
    const start = vi.fn();
    const discard = vi.fn();
    render(
      <RunStatusBanner
        word="start outcome unknown"
        detail="It may already have run."
        tone="caution"
        actions={[
          { id: 'start', label: 'Start anyway', onPress: start, tone: 'danger' },
          { id: 'discard', label: 'Discard', onPress: discard },
        ]}
      />,
    );

    await userEvent.tab();
    expect(document.activeElement?.textContent).toBe('Start anyway');
    await userEvent.keyboard('{Enter}');
    await userEvent.tab();
    expect(document.activeElement?.textContent).toBe('Discard');
    await userEvent.keyboard(' ');

    expect(start).toHaveBeenCalledTimes(1);
    expect(discard).toHaveBeenCalledTimes(1);
  });

  it('disables an action that cannot run now', async () => {
    const stop = vi.fn();
    render(
      <RunStatusBanner
        word="stopping"
        detail="Stopping…"
        actions={[{ id: 'stop', label: 'Stop', onPress: stop, isDisabled: true }]}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));

    expect(stop).not.toHaveBeenCalled();
  });

  it('renders no action row without actions', () => {
    render(<RunStatusBanner word="running" detail="Running." />);

    expect(screen.queryByRole('button')).toBeNull();
  });

  it('is not a live region, so the cockpit announcer speaks once', () => {
    const { container } = render(<RunStatusBanner word="running" detail="Running." />);

    expect(container.querySelector('[aria-live]')).toBeNull();
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <RunStatusBanner
        word="needs review"
        detail="Settings changed while this was queued."
        tone="attention"
        actions={[
          {
            id: 'current',
            label: 'Start with current settings',
            onPress: () => undefined,
            tone: 'primary',
          },
          { id: 'discard', label: 'Discard', onPress: () => undefined, tone: 'danger' },
        ]}
      >
        <p>yantra confirm run-1 grant</p>
      </RunStatusBanner>,
    );

    await expectNoAxeViolations(container);
  });
});
