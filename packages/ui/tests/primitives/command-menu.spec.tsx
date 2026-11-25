import { render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { CommandMenu, type CommandMenuSection } from '../../src/primitives/CommandMenu.js';

const SECTIONS: readonly CommandMenuSection[] = [
  {
    id: 'go',
    title: 'Go to',
    items: [
      { id: 'ledger', label: 'Ledger', description: 'Every run, newest first.' },
      { id: 'models', label: 'Models', hint: 'Settings · Setup' },
    ],
  },
  {
    id: 'commands',
    title: 'Commands',
    items: [{ id: 'doctor', label: 'yantra doctor', voice: 'engine' }],
  },
];

function Harness({ onAction }: { readonly onAction: (id: string) => void }): ReactNode {
  const [text, setText] = useState('');
  return (
    <CommandMenu
      inputLabel="Search Yantra"
      listLabel="Suggestions"
      inputValue={text}
      onInputChange={setText}
      sections={text === 'zzz' ? [] : SECTIONS}
      onAction={onAction}
      emptyState="Nothing matches."
    />
  );
}

describe('@no-llm Drshya CommandMenu', () => {
  it('shows titled sections with each item’s description and hint', () => {
    render(<Harness onAction={() => undefined} />);

    const list = screen.getByRole('menu', { name: 'Suggestions' });
    expect(within(list).getByText('Go to')).toBeTruthy();
    expect(within(list).getByText('Every run, newest first.')).toBeTruthy();
    expect(within(list).getByText('Settings · Setup')).toBeTruthy();
    expect(within(list).getAllByRole('menuitem')).toHaveLength(3);
  });

  it('keeps focus in the field while the arrow keys choose, and Enter acts', async () => {
    const onAction = vi.fn();
    render(<Harness onAction={onAction} />);
    const field = screen.getByRole('searchbox', { name: 'Search Yantra' });

    await userEvent.type(field, 'm');
    await userEvent.keyboard('{ArrowDown}{Enter}');

    expect(document.activeElement).toBe(field);
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(['ledger', 'models', 'doctor']).toContain(onAction.mock.calls[0]?.[0]);
  });

  it('says so when nothing matches', async () => {
    render(<Harness onAction={() => undefined} />);

    await userEvent.type(screen.getByRole('searchbox', { name: 'Search Yantra' }), 'zzz');

    expect(screen.getByText('Nothing matches.')).toBeTruthy();
  });
});
