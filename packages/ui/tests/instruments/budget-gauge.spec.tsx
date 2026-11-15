// @no-llm
/**
 * BudgetGauge (FEAT-067 TASK-003): one budget as `used / limit` text and a meter.
 */

import { render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import {
  BudgetGauge,
  BudgetGauges,
  budgetName,
  formatBudgetAmount,
  isExhausted,
} from '../../src/instruments/BudgetGauge.js';
import { TruncatedText } from '../../src/instruments/TruncatedText.js';
import { expectNoAxeViolations } from '../support/axe.js';

describe('BudgetGauge', () => {
  it('shows used and limit as text and as meter values', () => {
    render(<BudgetGauge value={{ name: 'tool_calls', used: 12, limit: 40, unit: 'count' }} />);

    const meter = screen.getByRole('meter', { name: 'tool calls' });
    expect(meter.getAttribute('aria-valuenow')).toBe('12');
    expect(meter.getAttribute('aria-valuemax')).toBe('40');
    expect(meter.getAttribute('aria-valuemin')).toBe('0');
    expect(meter.getAttribute('aria-valuetext')).toBe('12 of 40');
    expect(screen.getByText('12 / 40')).toBeDefined();
    expect(screen.queryByText('exhausted')).toBeNull();
  });

  it('names an exhausted budget in words', () => {
    const { container } = render(
      <BudgetGauge value={{ name: 'hops', used: 3, limit: 3, unit: 'count' }} />,
    );

    expect(screen.getByText('exhausted')).toBeDefined();
    expect(screen.getByRole('meter').getAttribute('aria-valuetext')).toBe('3 of 3, exhausted');
    expect(container.querySelector('[data-exhausted="true"]')).not.toBeNull();
  });

  it('caps the meter value at the limit when a budget overruns', () => {
    render(<BudgetGauge value={{ name: 'hops', used: 5, limit: 3, unit: 'count' }} />);

    expect(screen.getByRole('meter').getAttribute('aria-valuenow')).toBe('3');
    expect(screen.getByText('5 / 3')).toBeDefined();
  });

  it('shows an unbounded budget as what was used, with no meter', () => {
    render(<BudgetGauge value={{ name: 'captures', used: 2, limit: null, unit: 'count' }} />);

    expect(screen.queryByRole('meter')).toBeNull();
    expect(screen.getByText('2 used')).toBeDefined();
  });

  it('treats a zero limit as exhausted from the start', () => {
    render(<BudgetGauge value={{ name: 'hops', used: 0, limit: 0, unit: 'count' }} />);

    expect(screen.getByText('exhausted')).toBeDefined();
  });

  it('writes each unit in words people read', () => {
    expect(formatBudgetAmount(450, 'ms')).toBe('450 ms');
    expect(formatBudgetAmount(42_000, 'ms')).toBe('42s');
    expect(formatBudgetAmount(180_000, 'ms')).toBe('3m');
    expect(formatBudgetAmount(195_000, 'ms')).toBe('3m 15s');
    expect(formatBudgetAmount(3_600_000, 'ms')).toBe('1h');
    expect(formatBudgetAmount(5_400_000, 'ms')).toBe('1h 30m');
    expect(formatBudgetAmount(512, 'bytes')).toBe('512 B');
    expect(formatBudgetAmount(2_048, 'bytes')).toBe('2.0 KiB');
    expect(formatBudgetAmount(3 * 1_048_576, 'bytes')).toBe('3.0 MiB');
    expect(formatBudgetAmount(1_920_000, 'pixels')).toBe('1,920,000 px');
    expect(formatBudgetAmount(2_000_000, 'count')).toBe('2,000,000');
    expect(budgetName('model_calls')).toBe('model calls');
    expect(isExhausted({ name: 'x', used: 1, limit: null, unit: 'count' })).toBe(false);
  });
});

describe('BudgetGauges', () => {
  it('renders one gauge per dimension the snapshot carries', () => {
    render(
      <BudgetGauges
        dimensions={[
          { name: 'elapsed', used: 4_200, limit: 180_000, unit: 'ms' },
          { name: 'sources', used: 4, limit: 24, unit: 'count' },
        ]}
      />,
    );

    const list = screen.getByRole('list', { name: 'Budgets' });
    expect(
      within(list)
        .getAllByRole('meter')
        .map((meter) => meter.getAttribute('aria-label')),
    ).toEqual(['elapsed', 'sources']);
  });

  it('renders nothing without dimensions, so there is no dead gauge', () => {
    const { container } = render(<BudgetGauges dimensions={[]} />);

    expect(container.innerHTML).toBe('');
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <BudgetGauges
        dimensions={[
          { name: 'hops', used: 3, limit: 3, unit: 'count' },
          { name: 'captures', used: 1, limit: null, unit: 'count' },
        ]}
      />,
    );

    await expectNoAxeViolations(container);
  });
});

describe('TruncatedText', () => {
  it('keeps the full text in the DOM and shows it in a tooltip on focus', async () => {
    const goal = `find ${'very '.repeat(60)}quiet laptops`;
    render(<TruncatedText text={goal} />);

    await userEvent.tab();

    expect(document.activeElement?.textContent).toBe(goal);
    expect((await screen.findByRole('tooltip')).textContent).toBe(goal);
  });

  it('renders markup in the text as text', () => {
    const { container } = render(<TruncatedText text="<img src=x onerror=alert(1)>" />);

    expect(container.querySelector('img')).toBeNull();
  });
});
