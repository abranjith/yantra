import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { formatInvocation, parseInvocation, type CommandInvocation } from '@yantra/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppToasts } from '../../../src/app/shell/toasts.js';
import {
  browserPlatform,
  displayInvocation,
  formatTwin,
  hostShell,
} from '../../../src/features/cockpit/cli-twin.js';
import { CommandPanel } from '../../../src/features/cockpit/CommandPanel.js';

const CWD = process.platform === 'win32' ? 'C:\\work' : '/work';

function invocationOf(argv: readonly string[]): CommandInvocation {
  const parsed = parseInvocation(argv, { cwd: CWD, invocationId: '01JD2X7Q8R9S0T1V2W3X000003' });
  if (!parsed.isOk) throw new Error(parsed.error.message);
  return parsed.value.invocation;
}

const RESEARCH = invocationOf(['research', "q's $x `y` 100%", '--no-llm']);

let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
});

afterEach(() => {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
});

async function choose(shell: string): Promise<void> {
  await userEvent.click(screen.getByRole('button', { name: /Shell/u }));
  await userEvent.click(await screen.findByRole('option', { name: shell }));
}

function shown(): string | null {
  return document.querySelector('[data-part="command"]')?.textContent ?? null;
}

describe('@no-llm command panel', () => {
  it('shows exactly formatInvocation(invocation, shell) for each shell', async () => {
    render(<CommandPanel invocation={RESEARCH} />);

    for (const [label, shell] of [
      ['bash / zsh', 'posix'],
      ['PowerShell', 'powershell'],
    ] as const) {
      await choose(label);
      const expected = formatInvocation(RESEARCH, shell);
      expect(expected.ok).toBe(true);
      expect(shown()).toBe(expected.ok ? expected.text : null);
    }
    await choose('Command Prompt (cmd)');
    expect(shown()).toBeNull();
    expect(screen.getByText(/percent sign/u)).toBeDefined();
  });

  it('formats every shell, turning a refusal into its reason', () => {
    const twin = formatTwin(RESEARCH);

    expect(twin.posix).toEqual({
      text: (formatInvocation(RESEARCH, 'posix') as { text: string }).text,
    });
    expect('unavailable' in twin.cmd).toBe(true);
  });

  it('confirms a copy with a polite toast', async () => {
    render(
      <AppToasts>
        <CommandPanel invocation={RESEARCH} />
      </AppToasts>,
    );
    await choose('bash / zsh');

    await userEvent.click(screen.getByRole('button', { name: 'Copy' }));

    expect(writeText).toHaveBeenCalledWith(
      (formatInvocation(RESEARCH, 'posix') as { text: string }).text,
    );
    await waitFor(() => {
      expect(screen.getByText('Copied')).toBeDefined();
    });
  });

  it('shows a rebuilt command with its qualifier', () => {
    render(
      <CommandPanel
        invocation={null}
        reconstructed={{ invocation: invocationOf(['ask', 'old goal']), badge: 'Reconstructed' }}
      />,
    );

    expect(screen.getByText('Reconstructed')).toBeDefined();
  });

  it('says when no command is known yet', () => {
    render(<CommandPanel invocation={null} />);

    expect(screen.getByText(/not started from the app/u)).toBeDefined();
  });

  it('builds a display-only twin for a terminal answer', () => {
    const twin = formatTwin(displayInvocation(['confirm'], ['run-1', 'grant']));

    expect(twin.posix).toEqual({ text: 'yantra confirm run-1 grant' });
    expect(twin.cmd).toEqual({ text: 'yantra confirm run-1 grant' });
  });
});

describe('@no-llm default shell', () => {
  it('maps the browser platform to the host platform', () => {
    expect(browserPlatform({ userAgentData: { platform: 'Windows' } })).toBe('win32');
    expect(browserPlatform({ platform: 'Win32' })).toBe('win32');
    expect(browserPlatform({ platform: 'MacIntel' })).toBe('darwin');
    expect(browserPlatform({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' })).toBe('linux');
    expect(browserPlatform({})).toBe('linux');
  });

  it('defaults to PowerShell on Windows and POSIX elsewhere', () => {
    const platform = Object.getOwnPropertyDescriptor(Navigator.prototype, 'platform');
    Object.defineProperty(navigator, 'platform', { configurable: true, value: 'Win32' });
    expect(hostShell()).toBe('powershell');
    Object.defineProperty(navigator, 'platform', { configurable: true, value: 'Linux x86_64' });
    expect(hostShell()).toBe('posix');
    if (platform !== undefined) Object.defineProperty(Navigator.prototype, 'platform', platform);
    delete (navigator as { platform?: string }).platform;
  });
});
