import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Radio, RadioGroup } from '../../src/primitives/RadioGroup.js';
import { expectNoAxeViolations } from '../support/axe.js';

describe('@no-llm RadioGroup', () => {
  it('starts with no default selection when value is null', async () => {
    const onChange = vi.fn();
    const { container } = render(
      <RadioGroup label="Model provider" value={null} onChange={onChange}>
        <Radio value="anthropic">anthropic</Radio>
        <Radio value="ollama">ollama</Radio>
        <Radio value="none">none</Radio>
      </RadioGroup>,
    );

    const radios = screen.getAllByRole<HTMLInputElement>('radio');
    expect(radios).toHaveLength(3);
    expect(radios.every((radio) => !radio.checked)).toBe(true);

    const user = userEvent.setup();
    await user.click(radios[0]!);
    expect(onChange).toHaveBeenCalledWith('anthropic');
    await expectNoAxeViolations(container);
  });

  it('supports disabled options with inline descriptions', async () => {
    const onChange = vi.fn();
    const { container } = render(
      <RadioGroup label="Credential source" value={null} onChange={onChange}>
        <Radio value="environment variable">environment variable</Radio>
        <Radio value="keychain" isDisabled description="OS keychain is unavailable">
          keychain
        </Radio>
      </RadioGroup>,
    );

    const keychainRadio = screen.getByRole<HTMLInputElement>('radio', { name: /keychain/u });
    expect(keychainRadio.disabled).toBe(true);
    expect(screen.getByText('OS keychain is unavailable')).toBeDefined();
    await expectNoAxeViolations(container);
  });
});
