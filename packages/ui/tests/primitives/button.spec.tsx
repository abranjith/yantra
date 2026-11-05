import { act, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Button, buttonStyles } from '../../src/primitives/Button.js';

describe('@no-llm Drshya Button', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fires onPress once on click', async () => {
    const onPress = vi.fn();
    render(<Button onPress={onPress}>Run</Button>);

    await userEvent.click(screen.getByRole('button', { name: 'Run' }));

    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it.each(['{Enter}', ' '])('fires onPress once from the keyboard (%s)', async (key) => {
    const onPress = vi.fn();
    render(<Button onPress={onPress}>Run</Button>);

    await userEvent.tab();
    await userEvent.keyboard(key);

    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('does not fire when disabled, and leaves the tab order', async () => {
    const onPress = vi.fn();
    render(
      <Button onPress={onPress} isDisabled>
        Run
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Run' });

    await userEvent.click(button);
    await userEvent.tab();

    expect(onPress).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(button);
    expect(button.className).toContain('disabled:text-ink-3');
  });

  it('keeps a pending button focusable, blocks presses and announces progress', async () => {
    const onPress = vi.fn();
    render(
      <Button onPress={onPress} isPending>
        Saving
      </Button>,
    );
    const button = screen.getByRole('button', { name: /Saving/u });

    await userEvent.tab();
    expect(document.activeElement).toBe(button);
    await userEvent.keyboard('{Enter}');

    expect(onPress).not.toHaveBeenCalled();
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByRole('progressbar', { name: 'Pending' })).toBeDefined();
  });

  it('renders a leading registry icon, hidden from assistive technology', () => {
    render(<Button icon="action.retry">Retry</Button>);

    const button = screen.getByRole('button', { name: 'Retry' });
    const icon = button.querySelector('svg[data-icon="action.retry"]');
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
  });

  it('names an icon-only button by its aria-label', () => {
    render(<Button icon="action.copy" aria-label="Copy command" />);

    expect(screen.getByRole('button', { name: 'Copy command' })).toBeDefined();
  });

  it('rejects an icon-only button without a name, by type and at render', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    // @ts-expect-error an icon-only button must carry an aria-label
    render(<Button icon="action.copy" />);

    expect(warn).toHaveBeenCalledWith('Drshya Button: an icon-only button needs an aria-label.');
  });

  it('does not warn for a labelled button', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    render(<Button>Run</Button>);

    expect(warn).not.toHaveBeenCalled();
  });

  it('defaults to the secondary, medium button', () => {
    render(<Button>Run</Button>);

    const className = screen.getByRole('button', { name: 'Run' }).className;
    expect(className).toContain('bg-surface');
    expect(className).toContain('h-10');
    expect(className).toContain('rounded-control');
  });

  it('spends Ion only on the primary variant (apart from the shared focus ring)', () => {
    const fills = (variant: 'primary' | 'secondary' | 'quiet') =>
      buttonStyles({ variant })
        .split(' ')
        .filter((name) => !name.startsWith('focus-visible:') && name.includes('accent'));

    expect(fills('primary')).toEqual(
      expect.arrayContaining(['bg-accent', 'text-on-accent', 'hover:bg-accent-ink']),
    );
    expect(fills('secondary')).toEqual([]);
    expect(fills('quiet')).toEqual([]);
  });

  it('squares icon-only buttons per size', () => {
    expect(buttonStyles({ size: 'sm', iconOnly: true })).toContain('w-8');
    expect(buttonStyles({ size: 'md', iconOnly: true })).toContain('w-10');
  });

  it('lets a caller className override recipe classes by meaning', () => {
    render(<Button className="bg-sunken">Run</Button>);

    const className = screen.getByRole('button', { name: 'Run' }).className;
    expect(className).toContain('bg-sunken');
    expect(className.split(' ')).not.toContain('bg-surface');
  });

  it('carries the keyboard focus ring', async () => {
    render(<Button>Run</Button>);

    await act(async () => {
      await userEvent.tab();
    });

    const button = screen.getByRole('button', { name: 'Run' });
    expect(button.hasAttribute('data-focus-visible')).toBe(true);
    expect(button.className).toContain('focus-visible:outline-accent');
  });
});
