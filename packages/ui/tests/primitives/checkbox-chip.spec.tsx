import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { OutcomeBadge } from '../../src/instruments/OutcomeBadge.js';
import { Checkbox } from '../../src/primitives/Checkbox.js';

describe('@no-llm Drshya Checkbox, chip appearance', () => {
  it('is still a checkbox, named by its label', async () => {
    render(<Checkbox appearance="chip">Failed</Checkbox>);
    const box = screen.getByRole('checkbox', { name: 'Failed' });

    await userEvent.click(box);

    expect(box).toHaveProperty('checked', true);
  });

  it('shows a check mark when selected, so selection is not color alone', () => {
    const { container, rerender } = render(<Checkbox appearance="chip">Failed</Checkbox>);
    expect(container.querySelector('svg')).toBeNull();

    rerender(
      <Checkbox appearance="chip" isSelected>
        Failed
      </Checkbox>,
    );

    expect(container.querySelector('svg')).not.toBeNull();
  });
});

describe('@no-llm OutcomeBadge plain wording', () => {
  it('says the outcome in one capitalized word', () => {
    render(<OutcomeBadge status="completed" taskOutcome="fulfilled" wording="plain" />);
    expect(screen.getByText('Fulfilled')).toBeTruthy();
  });

  it('falls back to the status word when no outcome was recorded', () => {
    render(<OutcomeBadge status="completed" wording="plain" />);
    expect(screen.getByText('Completed')).toBeTruthy();
  });

  it('keeps the CLI words by default', () => {
    render(<OutcomeBadge status="completed" taskOutcome="fulfilled" />);
    expect(screen.getByText('completed fulfilled')).toBeTruthy();
  });
});
