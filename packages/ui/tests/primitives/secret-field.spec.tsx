import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';

import {
  SECRET_FIELD_DESCRIPTION,
  SecretField,
  type SecretFieldHandle,
} from '../../src/primitives/SecretField.js';
import { expectNoAxeViolations } from '../support/axe.js';

describe('@no-llm SecretField', () => {
  it('renders a password input with autocomplete off, spellcheck false, and no reveal toggle', () => {
    const { container } = render(<SecretField label="API key" />);

    const input = screen.getByLabelText('API key') as HTMLInputElement;
    expect(input.type).toBe('password');
    expect(input.getAttribute('autocomplete')).toBe('off');
    expect(input.getAttribute('spellcheck')).toBe('false');
    expect(input.hasAttribute('value')).toBe(false);
    expect(container.querySelectorAll('button')).toHaveLength(0);
    expect(screen.getByText(SECRET_FIELD_DESCRIPTION)).toBeDefined();
  });

  it('keeps the value out of the DOM value attribute and clears synchronously on submit', async () => {
    const user = userEvent.setup();
    const submitted: string[] = [];
    const onSubmit = vi.fn((value: string) => {
      // Input must already be cleared synchronously before or as onSubmit runs.
      const input = screen.getByLabelText('API key') as HTMLInputElement;
      expect(input.value).toBe('');
      submitted.push(value);
    });

    render(<SecretField label="API key" onSubmit={onSubmit} />);
    const input = screen.getByLabelText('API key') as HTMLInputElement;

    await user.type(input, 'CANARY_SECRET_123');
    expect(input.hasAttribute('value')).toBe(false);

    await user.keyboard('{Enter}');
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(submitted).toEqual(['CANARY_SECRET_123']);
    expect(input.value).toBe('');
  });

  it('reads and clears synchronously via fieldRef', async () => {
    const user = userEvent.setup();
    const fieldRef = createRef<SecretFieldHandle>();
    render(<SecretField label="API key" fieldRef={fieldRef} />);
    const input = screen.getByLabelText('API key') as HTMLInputElement;

    await user.type(input, 'CANARY_REF_456');
    expect(fieldRef.current?.readAndClear()).toBe('CANARY_REF_456');
    expect(input.value).toBe('');
    expect(input.hasAttribute('value')).toBe(false);
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <SecretField label="API key" isRequired isInvalid errorMessage="Required." />,
    );
    await expectNoAxeViolations(container);
  });
});
