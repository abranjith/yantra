/**
 * CommandMenu: a search field over a grouped list of things to do, for the
 * command palette (Interface Study 01).
 *
 * React Aria's Autocomplete keeps focus in the field while the arrow keys move
 * through the list (virtual focus), and Enter acts on the highlighted item, so
 * typing and choosing never fight. The first result is highlighted as you
 * type, so Enter does the obvious thing.
 *
 * The caller owns the results: it filters and ranks them, and passes only
 * non-empty sections. Each item can say what it does (`description`) and
 * where it leads (`hint`); a command line is set in the engine voice.
 */

import type { ReactNode } from 'react';
import {
  Autocomplete,
  Dialog as AriaDialog,
  Header,
  Input,
  Menu as AriaMenu,
  MenuItem as AriaMenuItem,
  MenuSection as AriaMenuSection,
  Modal,
  ModalOverlay,
  SearchField,
  Text,
} from 'react-aria-components';

import { Icon } from '../icons/Icon.js';
import type { IconName } from '../icons/registry.js';
import { cn } from '../lib/cn.js';

/** One thing the menu offers. */
export interface CommandMenuItem {
  readonly id: string;
  /** What it is, in a few words; also what the screen reader announces. */
  readonly label: string;
  /** What happens, in a sentence. */
  readonly description?: string;
  readonly icon?: IconName;
  /** Where it leads or what it belongs to, right-aligned ("Settings · Setup"). */
  readonly hint?: string;
  /** `engine` sets the label in mono: a command line. */
  readonly voice?: 'body' | 'engine';
  readonly isDisabled?: boolean;
}

/** A titled group of items. */
export interface CommandMenuSection {
  readonly id: string;
  readonly title: string;
  readonly items: readonly CommandMenuItem[];
}

export interface CommandMenuProps {
  /** The accessible name of the search field. */
  readonly inputLabel: string;
  /** The accessible name of the result list. */
  readonly listLabel: string;
  readonly placeholder?: string;
  readonly inputValue: string;
  readonly onInputChange: (value: string) => void;
  /** Non-empty sections, in display order. */
  readonly sections: readonly CommandMenuSection[];
  readonly onAction: (id: string) => void;
  /**
   * Enter in the field when no item is highlighted (every result is disabled,
   * or there is none), so the caller can say why nothing happened.
   */
  readonly onSubmit?: (value: string) => void;
  /** Shown when there are no sections. */
  readonly emptyState?: ReactNode;
  readonly className?: string;
}

function Item({ item }: { readonly item: CommandMenuItem }): ReactNode {
  return (
    <AriaMenuItem
      id={item.id}
      textValue={item.label}
      isDisabled={item.isDisabled === true}
      className="group flex cursor-default items-center gap-3 rounded-control px-3 py-2 text-ink outline-hidden data-[disabled]:text-ink-3 data-[focused]:bg-sunken"
    >
      {item.icon === undefined ? (
        <span aria-hidden="true" className="w-4 shrink-0" />
      ) : (
        <span className="shrink-0 text-ink-3 group-data-[focused]:text-accent-ink">
          <Icon name={item.icon} size={16} />
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col">
        <Text
          slot="label"
          className={cn(
            'truncate',
            item.voice === 'engine' ? 'type-engine text-caption' : 'text-body font-medium',
          )}
        >
          {item.label}
        </Text>
        {item.description === undefined || item.description === '' ? null : (
          <Text slot="description" className="truncate text-caption text-ink-3">
            {item.description}
          </Text>
        )}
      </span>
      {item.hint === undefined ? null : (
        <span className="shrink-0 text-caption text-ink-3">{item.hint}</span>
      )}
      <span
        aria-hidden="true"
        className="invisible shrink-0 text-ink-3 group-data-[focused]:visible group-data-[disabled]:hidden"
      >
        <Icon name="action.enter" size={16} />
      </span>
    </AriaMenuItem>
  );
}

/** See the module comment. */
export function CommandMenu({
  inputLabel,
  listLabel,
  placeholder,
  inputValue,
  onInputChange,
  sections,
  onAction,
  onSubmit,
  emptyState,
  className,
}: CommandMenuProps): ReactNode {
  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      <Autocomplete inputValue={inputValue} onInputChange={onInputChange}>
        <SearchField
          {...(onSubmit === undefined ? {} : { onSubmit })}
          aria-label={inputLabel}
          autoFocus
          className="flex shrink-0 items-center gap-3 border-b border-rule px-4"
        >
          <span className="text-ink-3">
            <Icon name="action.search" size={20} />
          </span>
          <Input
            {...(placeholder === undefined ? {} : { placeholder })}
            className="h-14 min-w-0 flex-1 bg-transparent text-lead text-ink outline-hidden placeholder:text-ink-3 [&::-webkit-search-cancel-button]:hidden"
          />
        </SearchField>
        <AriaMenu
          aria-label={listLabel}
          onAction={(key) => {
            onAction(String(key));
          }}
          renderEmptyState={() => (
            <div className="px-4 py-6 text-center text-ink-2">{emptyState}</div>
          )}
          className="min-h-0 flex-1 overflow-y-auto p-2 outline-hidden"
        >
          {sections.map((section) => (
            <AriaMenuSection key={section.id} id={section.id} className="pb-1">
              <Header className="px-3 pt-2.5 pb-1.5 type-label text-ink-3">{section.title}</Header>
              {section.items.map((item) => (
                <Item key={item.id} item={item} />
              ))}
            </AriaMenuSection>
          ))}
        </AriaMenu>
      </Autocomplete>
    </div>
  );
}

export interface CommandMenuDialogProps {
  readonly isOpen: boolean;
  readonly onOpenChange: (isOpen: boolean) => void;
  /** The dialog's accessible name; the palette shows no title, its field says what to do. */
  readonly 'aria-label': string;
  readonly children: ReactNode;
}

/**
 * The palette's panel: anchored near the top of the window, so results grow
 * downward without the field moving, on solid paper over the dialog scrim.
 * Escape clears the field first, then closes; an outside click closes.
 */
export function CommandMenuDialog({
  isOpen,
  onOpenChange,
  children,
  ...label
}: CommandMenuDialogProps): ReactNode {
  return (
    <ModalOverlay
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      isDismissable
      className="fixed inset-0 z-50 flex items-start justify-center bg-(--dialog-scrim) px-4 pt-[12vh]"
    >
      <Modal className="flex max-h-[76vh] w-full max-w-160 flex-col overflow-hidden rounded-frame border border-rule-strong bg-surface text-ink">
        <AriaDialog
          aria-label={label['aria-label']}
          className="flex min-h-0 flex-col outline-hidden"
        >
          {children}
        </AriaDialog>
      </Modal>
    </ModalOverlay>
  );
}
