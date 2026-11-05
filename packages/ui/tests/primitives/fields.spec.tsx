import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Checkbox } from '../../src/primitives/Checkbox.js';
import { NumberField } from '../../src/primitives/NumberField.js';
import { Switch } from '../../src/primitives/Switch.js';
import { TextField } from '../../src/primitives/TextField.js';
import { CONTRAST_PAIRINGS } from '../../src/tokens/pairings.js';

function describedBy(element: HTMLElement): string {
  return (element.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' | ');
}

describe('@no-llm Drshya field anatomy', () => {
  it('associates label and description with a text field', () => {
    render(<TextField label="Goal" description="What the run should accomplish." />);

    const input = screen.getByRole('textbox', { name: 'Goal' });
    expect(describedBy(input)).toContain('What the run should accomplish.');
  });

  it('marks an invalid field and shows its error, associated with the input', () => {
    render(
      <TextField
        label="Profile name"
        isInvalid
        errorMessage="Use letters, digits and dashes only."
      />,
    );

    const input = screen.getByRole('textbox', { name: 'Profile name' });
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('Use letters, digits and dashes only.')).toBeDefined();
    expect(describedBy(input)).toContain('Use letters, digits and dashes only.');
  });

  it('shows no error text while the field is valid', () => {
    render(<TextField label="Profile name" errorMessage="Use letters only." />);

    expect(screen.queryByText('Use letters only.')).toBeNull();
  });

  it('pairs the error with the failed icon, not color alone', () => {
    render(<TextField label="Profile name" isInvalid errorMessage="Invalid." />);

    const error = screen.getByText('Invalid.');
    expect(error.querySelector('svg[data-icon="outcome.failed"]')).not.toBeNull();
    expect(error.className).toContain('text-signal-failed-ink');
  });

  it('shows a visible "required" word, not only an asterisk', () => {
    render(<TextField label="Start URL" isRequired />);

    const input = screen.getByRole('textbox', { name: /Start URL/u });
    expect(input.hasAttribute('required') || input.getAttribute('aria-required') === 'true').toBe(
      true,
    );
    expect(screen.getByText('required')).toBeDefined();
  });

  it('renders a multiline field as a textarea', () => {
    render(<TextField label="Notes" multiline />);

    expect(screen.getByRole('textbox', { name: 'Notes' }).tagName).toBe('TEXTAREA');
  });

  it('sets the engine voice for IDs and URLs', () => {
    render(<TextField label="Run ID" voice="engine" />);

    expect(screen.getByRole('textbox', { name: 'Run ID' }).className).toContain('type-engine');
  });

  it('reports typed text', async () => {
    const onChange = vi.fn();
    render(<TextField label="Goal" onChange={onChange} />);

    await userEvent.type(screen.getByRole('textbox', { name: 'Goal' }), 'abc');

    expect(onChange).toHaveBeenLastCalledWith('abc');
  });

  it('keeps the field-edge boundary at 3:1 on every surface (contrast gate)', () => {
    const fieldEdge = CONTRAST_PAIRINGS.filter(
      (pairing) => pairing.fg === 'field-edge' && pairing.kind === 'non-text',
    ).map((pairing) => pairing.bg);

    expect(fieldEdge.sort()).toEqual(['bg', 'sunken', 'surface']);
  });
});

describe('@no-llm Drshya NumberField', () => {
  it('clamps to the minimum and maximum on blur', async () => {
    render(<NumberField label="Max hops" defaultValue={12} minValue={1} maxValue={50} />);
    const input = screen.getByRole('textbox', { name: 'Max hops' });

    await userEvent.clear(input);
    await userEvent.type(input, '99');
    await userEvent.tab();
    expect((input as HTMLInputElement).value).toBe('50');

    await userEvent.clear(input);
    await userEvent.type(input, '0');
    await userEvent.tab();
    expect((input as HTMLInputElement).value).toBe('1');
  });

  it('names its stepper buttons and steps with them', async () => {
    render(<NumberField label="Max hops" defaultValue={12} step={2} />);

    await userEvent.click(screen.getByRole('button', { name: 'Increase Max hops' }));
    expect((screen.getByRole('textbox', { name: 'Max hops' }) as HTMLInputElement).value).toBe(
      '14',
    );

    await userEvent.click(screen.getByRole('button', { name: 'Decrease Max hops' }));
    expect((screen.getByRole('textbox', { name: 'Max hops' }) as HTMLInputElement).value).toBe(
      '12',
    );
  });

  it('steps with the arrow keys', async () => {
    render(<NumberField label="Max hops" defaultValue={12} />);

    await userEvent.click(screen.getByRole('textbox', { name: 'Max hops' }));
    await userEvent.keyboard('{ArrowUp}');

    expect((screen.getByRole('textbox', { name: 'Max hops' }) as HTMLInputElement).value).toBe(
      '13',
    );
  });

  it('formats with the locale', () => {
    render(
      <NumberField
        label="Budget"
        defaultValue={2.5}
        formatOptions={{ style: 'currency', currency: 'USD' }}
      />,
    );

    expect((screen.getByRole('textbox', { name: 'Budget' }) as HTMLInputElement).value).toBe(
      '$2.50',
    );
  });
});

describe('@no-llm Drshya Checkbox', () => {
  it('toggles with Space', async () => {
    const onChange = vi.fn();
    render(<Checkbox onChange={onChange}>Cite every claim</Checkbox>);
    const checkbox = screen.getByRole('checkbox', { name: 'Cite every claim' });

    await userEvent.tab();
    await userEvent.keyboard(' ');

    expect(onChange).toHaveBeenLastCalledWith(true);
    expect((checkbox as HTMLInputElement).checked).toBe(true);
  });

  it('shows a check mark when selected, so state is not color alone', () => {
    render(<Checkbox defaultSelected>Cite every claim</Checkbox>);

    const box = document.querySelector('[data-focus-indicator]');
    expect(box?.querySelector('svg[data-icon="nav.check"]')).not.toBeNull();
    expect(box?.className).toContain('bg-accent');
  });

  it('exposes indeterminate as mixed and draws a dash', () => {
    render(<Checkbox isIndeterminate>Some sources</Checkbox>);

    const checkbox = screen.getByRole('checkbox', { name: 'Some sources' }) as HTMLInputElement;
    expect(checkbox.indeterminate || checkbox.getAttribute('aria-checked') === 'mixed').toBe(true);
    expect(document.querySelector('svg[data-icon="field.decrement"]')).not.toBeNull();
  });

  it('does not toggle when disabled', async () => {
    const onChange = vi.fn();
    render(
      <Checkbox isDisabled onChange={onChange}>
        Allow uploads
      </Checkbox>,
    );

    await userEvent.click(screen.getByText('Allow uploads'));

    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('@no-llm Drshya Switch', () => {
  it('toggles with Space and reports aria-checked', async () => {
    const onChange = vi.fn();
    render(<Switch onChange={onChange}>Solid surfaces</Switch>);
    const toggle = screen.getByRole('switch', { name: 'Solid surfaces' });

    expect((toggle as HTMLInputElement).checked).toBe(false);
    await userEvent.tab();
    await userEvent.keyboard(' ');

    expect(onChange).toHaveBeenLastCalledWith(true);
    expect((toggle as HTMLInputElement).checked).toBe(true);
  });

  it('renders the check mark in the thumb when on, and none when off', async () => {
    render(<Switch>Solid surfaces</Switch>);
    expect(document.querySelector('svg[data-icon="nav.check"]')).toBeNull();

    await userEvent.click(screen.getByText('Solid surfaces'));

    expect(document.querySelector('svg[data-icon="nav.check"]')).not.toBeNull();
    const thumb = document.querySelector('svg[data-icon="nav.check"]')?.parentElement;
    expect(thumb?.className).toContain('translate-x-4');
  });

  it('animates at --duration-quick, which reduced motion zeroes', () => {
    render(<Switch>Solid surfaces</Switch>);

    const track = document.querySelector('[data-focus-indicator]');
    expect(track?.className).toContain('duration-(--duration-quick)');
  });
});
