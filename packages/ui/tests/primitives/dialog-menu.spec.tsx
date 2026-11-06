import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Button } from '../../src/primitives/Button.js';
import { Dialog, DialogTrigger } from '../../src/primitives/Dialog.js';
import {
  Menu,
  MenuItem,
  MenuSection,
  MenuSeparator,
  MenuTrigger,
} from '../../src/primitives/Menu.js';

function Rename({ onRename }: { readonly onRename?: () => void }) {
  return (
    <DialogTrigger>
      <Button>Rename workflow</Button>
      <Dialog title="Rename workflow">
        {({ close }) => (
          <>
            <Button onPress={close}>Cancel</Button>
            <Button
              variant="primary"
              onPress={() => {
                onRename?.();
                close();
              }}
            >
              Rename
            </Button>
          </>
        )}
      </Dialog>
    </DialogTrigger>
  );
}

function ConfirmDelete() {
  return (
    <DialogTrigger>
      <Button>Delete run</Button>
      <Dialog title="Delete this run?" role="alertdialog">
        {({ close }) => <Button onPress={close}>Keep run</Button>}
      </Dialog>
    </DialogTrigger>
  );
}

describe('@no-llm Drshya Dialog', () => {
  it('moves focus inside when opened by the person, and restores it to the trigger on close', async () => {
    render(<Rename />);
    const trigger = screen.getByRole('button', { name: 'Rename workflow' });

    await userEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Rename workflow' });
    expect(dialog.contains(document.activeElement)).toBe(true);

    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => {
      expect(document.activeElement).toBe(trigger);
    });
  });

  it('traps Tab inside the dialog', async () => {
    render(<Rename />);
    await userEvent.click(screen.getByRole('button', { name: 'Rename workflow' }));
    const dialog = screen.getByRole('dialog');

    for (let press = 0; press < 5; press += 1) {
      await userEvent.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  it('dismisses a plain dialog with Escape', async () => {
    render(<Rename />);
    await userEvent.click(screen.getByRole('button', { name: 'Rename workflow' }));

    await userEvent.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('names the dialog by its title heading', async () => {
    render(<Rename />);
    await userEvent.click(screen.getByRole('button', { name: 'Rename workflow' }));

    const dialog = screen.getByRole('dialog', { name: 'Rename workflow' });
    expect(within(dialog).getByRole('heading', { name: 'Rename workflow' })).toBeDefined();
  });

  it('renders on a solid surface over the dialog scrim, never glass', async () => {
    render(<Rename />);
    await userEvent.click(screen.getByRole('button', { name: 'Rename workflow' }));

    const dialog = screen.getByRole('dialog');
    expect(dialog.closest('.glass')).toBeNull();
    expect(dialog.parentElement?.className).toContain('bg-surface');
    expect(document.querySelector('.bg-\\(--dialog-scrim\\)')).not.toBeNull();
  });

  describe('alertdialog', () => {
    it('uses the alertdialog role', async () => {
      render(<ConfirmDelete />);
      await userEvent.click(screen.getByRole('button', { name: 'Delete run' }));

      expect(screen.getByRole('alertdialog', { name: 'Delete this run?' })).toBeDefined();
    });

    it('is not dismissed by Escape', async () => {
      render(<ConfirmDelete />);
      await userEvent.click(screen.getByRole('button', { name: 'Delete run' }));

      await userEvent.keyboard('{Escape}');

      expect(screen.getByRole('alertdialog')).toBeDefined();
    });

    it('is not dismissed by an outside click', async () => {
      render(<ConfirmDelete />);
      await userEvent.click(screen.getByRole('button', { name: 'Delete run' }));
      const scrim = document.querySelector('.bg-\\(--dialog-scrim\\)');
      if (!(scrim instanceof HTMLElement)) {
        throw new Error('no scrim rendered');
      }

      await userEvent.click(scrim);

      expect(screen.getByRole('alertdialog')).toBeDefined();
    });

    it('closes through its explicit button', async () => {
      render(<ConfirmDelete />);
      await userEvent.click(screen.getByRole('button', { name: 'Delete run' }));

      await userEvent.click(screen.getByRole('button', { name: 'Keep run' }));

      expect(screen.queryByRole('alertdialog')).toBeNull();
    });
  });

  it('requires a title by type', () => {
    const element = (
      // @ts-expect-error a dialog must have a title heading
      <Dialog>content</Dialog>
    );

    expect(element).toBeDefined();
  });
});

describe('@no-llm Drshya Menu', () => {
  function RunActions({ onAction }: { readonly onAction: (key: unknown) => void }) {
    return (
      <MenuTrigger>
        <Button>Run actions</Button>
        <Menu aria-label="Run actions" onAction={onAction}>
          <MenuSection title="Run">
            <MenuItem id="resume" icon="action.retry">
              Resume
            </MenuItem>
            <MenuItem id="schedule" isDisabled>
              Schedule
            </MenuItem>
            <MenuItem id="copy" icon="action.copy">
              Copy CLI command
            </MenuItem>
          </MenuSection>
          <MenuSeparator />
          <MenuSection title="Danger">
            <MenuItem id="delete" tone="destructive" icon="outcome.failed">
              Delete run
            </MenuItem>
          </MenuSection>
        </Menu>
      </MenuTrigger>
    );
  }

  it('opens on the first item, moves with arrows and skips disabled items', async () => {
    render(<RunActions onAction={() => undefined} />);

    await userEvent.tab();
    await userEvent.keyboard('{Enter}');
    const menu = screen.getByRole('menu', { name: 'Run actions' });
    expect(document.activeElement).toBe(within(menu).getByRole('menuitem', { name: 'Resume' }));

    await userEvent.keyboard('{ArrowDown}');

    expect(document.activeElement).toBe(
      within(menu).getByRole('menuitem', { name: 'Copy CLI command' }),
    );
  });

  it('jumps by typeahead', async () => {
    render(<RunActions onAction={() => undefined} />);

    await userEvent.tab();
    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard('d');

    expect(document.activeElement?.textContent).toContain('Delete run');
  });

  it('fires onAction with Enter and closes', async () => {
    const onAction = vi.fn();
    render(<RunActions onAction={onAction} />);

    await userEvent.tab();
    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard('{Enter}');

    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction.mock.calls[0]?.[0]).toBe('resume');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('marks a destructive item with its icon, not color alone', async () => {
    render(<RunActions onAction={() => undefined} />);

    await userEvent.click(screen.getByRole('button', { name: 'Run actions' }));

    const destructive = screen.getByRole('menuitem', { name: 'Delete run' });
    expect(destructive.getAttribute('data-tone')).toBe('destructive');
    const icon = destructive.querySelector('svg[data-icon="outcome.failed"]');
    expect(icon).not.toBeNull();
    expect(icon?.parentElement?.className).toContain('text-signal-failed');
    expect(destructive.className).not.toMatch(/text-signal/u);
  });

  it('requires an icon on a destructive item by type', () => {
    const element = (
      // @ts-expect-error a destructive item must carry an icon
      <MenuItem id="delete" tone="destructive">
        Delete run
      </MenuItem>
    );

    expect(element).toBeDefined();
  });

  it('labels its sections', async () => {
    render(<RunActions onAction={() => undefined} />);

    await userEvent.click(screen.getByRole('button', { name: 'Run actions' }));

    expect(screen.getByText('Danger')).toBeDefined();
    expect(screen.getAllByRole('group').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole('separator')).toBeDefined();
  });
});
