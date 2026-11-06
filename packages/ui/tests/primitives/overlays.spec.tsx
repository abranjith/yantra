import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Button } from '../../src/primitives/Button.js';
import { ComboBox } from '../../src/primitives/ComboBox.js';
import {
  optionStyles,
  Popover,
  PopoverDialog,
  PopoverTrigger,
  popoverStyles,
} from '../../src/primitives/Popover.js';
import { Select, type ListOption } from '../../src/primitives/Select.js';

const PROVIDERS: readonly ListOption[] = [
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'ollama', label: 'Ollama' },
  { id: 'none', label: 'No model' },
  { id: 'other', label: 'Other', isDisabled: true },
];

const SEARCH: readonly ListOption[] = [
  { id: 'brave', label: 'Brave Search' },
  { id: 'searxng', label: 'SearXNG' },
  { id: 'duckduckgo', label: 'DuckDuckGo' },
];

function trigger(name: RegExp): HTMLElement {
  return screen.getByRole('button', { name });
}

describe('@no-llm Drshya Select', () => {
  it.each([
    ['Enter', '{Enter}'],
    ['Space', ' '],
    ['Alt+ArrowDown', '{Alt>}{ArrowDown}{/Alt}'],
  ])('opens with %s', async (_name, keys) => {
    render(<Select label="Model provider" options={PROVIDERS} />);

    await userEvent.tab();
    await userEvent.keyboard(keys);

    expect(screen.getByRole('listbox')).toBeDefined();
  });

  it('moves with the arrow keys, selects with Enter, closes and returns focus', async () => {
    const onSelectionChange = vi.fn();
    render(
      <Select label="Model provider" options={PROVIDERS} onSelectionChange={onSelectionChange} />,
    );

    await userEvent.tab();
    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard('{ArrowDown}');
    await userEvent.keyboard('{Enter}');

    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onSelectionChange).toHaveBeenCalledTimes(1);
    expect(onSelectionChange).toHaveBeenCalledWith('ollama');
    // React Aria restores focus on the next frame.
    await waitFor(() => {
      expect(document.activeElement).toBe(trigger(/Ollama/u));
    });
  });

  it('shows the placeholder until something is selected', () => {
    render(<Select label="Model provider" options={PROVIDERS} placeholder="Choose one" />);

    expect(trigger(/Choose one/u)).toBeDefined();
  });

  it('marks the selected option with a check mark, not color alone', async () => {
    render(<Select label="Model provider" options={PROVIDERS} defaultSelectedKey="anthropic" />);

    await userEvent.click(trigger(/Anthropic/u));

    const selected = within(screen.getByRole('listbox')).getByRole('option', { name: 'Anthropic' });
    expect(selected.getAttribute('aria-selected')).toBe('true');
    expect(selected.querySelector('svg[data-icon="nav.check"]')).not.toBeNull();
  });

  it('skips disabled options', async () => {
    render(<Select label="Model provider" options={PROVIDERS} />);

    await userEvent.click(trigger(/Select/u));

    const other = within(screen.getByRole('listbox')).getByRole('option', { name: 'Other' });
    expect(other.getAttribute('aria-disabled')).toBe('true');
  });

  it('renders its list on glass', async () => {
    render(<Select label="Model provider" options={PROVIDERS} />);

    await userEvent.click(trigger(/Select/u));

    expect(screen.getByRole('listbox').closest('.glass')).not.toBeNull();
  });
});

describe('@no-llm Drshya ComboBox', () => {
  it('filters options as you type (contains)', async () => {
    render(<ComboBox label="Search provider" options={SEARCH} />);

    await userEvent.type(screen.getByRole('combobox', { name: 'Search provider' }), 'se');

    const names = within(screen.getByRole('listbox'))
      .getAllByRole('option')
      .map((option) => option.textContent);
    expect(names).toEqual(['Brave Search', 'SearXNG']);
  });

  it('shows "No matches" for an empty result', async () => {
    render(<ComboBox label="Search provider" options={SEARCH} />);

    await userEvent.type(screen.getByRole('combobox', { name: 'Search provider' }), 'zzz');

    expect(within(screen.getByRole('listbox')).getByText('No matches')).toBeDefined();
  });

  it('closes on Escape and keeps the typed text', async () => {
    render(<ComboBox label="Search provider" options={SEARCH} allowsCustomValue />);
    const input = screen.getByRole('combobox', { name: 'Search provider' }) as HTMLInputElement;

    await userEvent.type(input, 'sea');
    expect(screen.getByRole('listbox')).toBeDefined();
    await userEvent.keyboard('{Escape}');

    expect(screen.queryByRole('listbox')).toBeNull();
    expect(input.value).toBe('sea');
  });

  it('selects an option with the keyboard', async () => {
    const onSelectionChange = vi.fn();
    render(
      <ComboBox label="Search provider" options={SEARCH} onSelectionChange={onSelectionChange} />,
    );

    await userEvent.type(screen.getByRole('combobox', { name: 'Search provider' }), 'duck');
    await userEvent.keyboard('{ArrowDown}{Enter}');

    expect(onSelectionChange).toHaveBeenLastCalledWith('duckduckgo');
  });
});

describe('@no-llm Drshya Popover', () => {
  function Provenance() {
    return (
      <PopoverTrigger>
        <Button>Provenance</Button>
        <Popover>
          <PopoverDialog aria-label="How this URL was found">
            <p>goal → search → page</p>
          </PopoverDialog>
        </Popover>
      </PopoverTrigger>
    );
  }

  it('never opens on mount unless controlled', () => {
    render(<Provenance />);

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes on Escape and returns focus to the trigger', async () => {
    render(<Provenance />);

    await userEvent.tab();
    await userEvent.keyboard('{Enter}');
    expect(screen.getByRole('dialog', { name: 'How this URL was found' })).toBeDefined();

    await userEvent.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Provenance' }));
    });
  });

  it('is glass, which the Solid-mode rule turns opaque', async () => {
    render(<Provenance />);

    await userEvent.click(screen.getByRole('button', { name: 'Provenance' }));

    expect(screen.getByRole('dialog').closest('.glass')).not.toBeNull();
  });
});

describe('@no-llm Drshya glass text rule', () => {
  const sourceDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/primitives');

  it('uses only ink and ink-2 text in the glass overlay recipes', () => {
    for (const recipe of [popoverStyles(), optionStyles()]) {
      const textColors = recipe
        .split(' ')
        .map((name) => name.replace(/^.*:/u, ''))
        .filter((name) => /^text-(?:ink|accent|signal|on-)/u.test(name));
      expect(textColors.every((name) => name === 'text-ink' || name === 'text-ink-2')).toBe(true);
    }
  });

  it('keeps text-ink-3 out of every overlay source file', () => {
    for (const file of ['Popover.tsx', 'Select.tsx', 'ComboBox.tsx']) {
      expect(readFileSync(resolve(sourceDir, file), 'utf8')).not.toContain('text-ink-3');
    }
  });
});
