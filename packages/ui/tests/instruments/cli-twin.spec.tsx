// @no-llm
/**
 * CliTwin (FEAT-067 TASK-007): the command for the user's shell, with Copy.
 */

import { render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CliTwin, type TwinFormat, type TwinShell } from '../../src/instruments/CliTwin.js';
import { expectNoAxeViolations } from '../support/axe.js';

const FORMATTED: Readonly<Record<TwinShell, TwinFormat>> = {
  posix: { text: "yantra research 'q'\\''s $x' --no-llm" },
  powershell: { text: "yantra research 'q''s $x' --no-llm" },
  cmd: { unavailable: 'cmd cannot run this command: argument 2 contains a line break' },
};

let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
});

afterEach(() => {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
});

function command(): string | null {
  return document.querySelector('[data-part="command"]')?.textContent ?? null;
}

async function choose(shell: string): Promise<void> {
  await userEvent.click(screen.getByRole('button', { name: /Shell/u }));
  await userEvent.click(await screen.findByRole('option', { name: shell }));
}

describe('CliTwin', () => {
  it('starts on the default shell and shows its command in the engine voice', () => {
    render(<CliTwin formatted={FORMATTED} defaultShell="powershell" />);

    expect(command()).toBe("yantra research 'q''s $x' --no-llm");
    expect(document.querySelector('[data-part="command"]')?.className).toContain('type-engine');
    expect(
      within(screen.getByRole('button', { name: /Shell/u })).getByText('PowerShell'),
    ).toBeDefined();
  });

  it('copies the exact text of the selected shell', async () => {
    const copied = vi.fn();
    render(<CliTwin formatted={FORMATTED} defaultShell="powershell" onCopied={copied} />);

    await choose('bash / zsh');
    await userEvent.click(screen.getByRole('button', { name: 'Copy' }));

    expect(writeText).toHaveBeenCalledWith("yantra research 'q'\\''s $x' --no-llm");
    expect(copied).toHaveBeenCalledWith("yantra research 'q'\\''s $x' --no-llm", 'posix');
  });

  it('says why a shell cannot carry the command and turns Copy off', async () => {
    render(<CliTwin formatted={FORMATTED} defaultShell="posix" />);

    await choose('Command Prompt (cmd)');

    expect(command()).toBeNull();
    expect(screen.getByText(/argument 2 contains a line break/u)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Copy' }).hasAttribute('disabled')).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).not.toHaveBeenCalled();
  });

  it('reports a copy the browser refused', async () => {
    writeText.mockImplementation(() => Promise.reject(new Error('denied')));
    const failed = vi.fn();
    render(<CliTwin formatted={FORMATTED} defaultShell="posix" onCopyFailed={failed} />);

    await userEvent.click(screen.getByRole('button', { name: 'Copy' }));

    expect(failed).toHaveBeenCalledWith('posix');
  });

  it('reports a missing Clipboard API', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    const failed = vi.fn();
    render(<CliTwin formatted={FORMATTED} defaultShell="posix" onCopyFailed={failed} />);

    await userEvent.click(screen.getByRole('button', { name: 'Copy' }));

    expect(failed).toHaveBeenCalledWith('posix');
  });

  it('shows a qualifier badge and is not a live region', () => {
    const { container } = render(
      <CliTwin formatted={FORMATTED} defaultShell="posix" badge="Reconstructed" label="This run" />,
    );

    expect(screen.getByText('Reconstructed')).toBeDefined();
    expect(screen.getByText('This run')).toBeDefined();
    expect(container.querySelector('[aria-live]')).toBeNull();
  });

  it('renders untrusted command text as text', () => {
    const { container } = render(
      <CliTwin
        formatted={{ ...FORMATTED, posix: { text: "yantra ask '<img src=x onerror=alert(1)>'" } }}
        defaultShell="posix"
      />,
    );

    expect(container.querySelector('img')).toBeNull();
  });

  it('has no axe violations', async () => {
    const { container } = render(<CliTwin formatted={FORMATTED} defaultShell="posix" />);

    await expectNoAxeViolations(container);
  });
});
