/**
 * Glass overlays (TASK-013): the popover surface shared by Popover, Select,
 * ComboBox and Menu, and the option rows they list.
 *
 * Content on glass uses only GLASS_TEXT_TOKENS (`ink`, `ink-2`; spec S3).
 * Ion appears only as a graphic: the focus outline and the check mark.
 * In Solid mode the `glass` utility turns opaque (TASK-004).
 */

import type { ReactNode } from 'react';
import {
  Dialog as AriaDialog,
  DialogTrigger,
  ListBoxItem as AriaListBoxItem,
  Popover as AriaPopover,
  type DialogProps as AriaDialogProps,
  type DialogTriggerProps,
  type ListBoxItemProps as AriaListBoxItemProps,
  type PopoverProps as AriaPopoverProps,
} from 'react-aria-components';

import { Icon } from '../icons/Icon.js';
import { cn, tv } from '../lib/cn.js';

/** The glass panel every overlay uses. */
export const popoverStyles = tv({
  base: 'glass max-h-80 min-w-(--trigger-width) overflow-auto rounded-control p-1 text-ink outline-hidden',
});

/**
 * An option row on glass: `ink` text, `ink-2` for disabled, an Ion outline
 * for the focused option (the React Aria plugin's `focus:` variant, i.e.
 * `data-focused`) and a check mark (not color) for selection.
 */
export const optionStyles = tv({
  base: 'flex cursor-default items-center gap-2 rounded-chip px-2 py-1.5 text-ink outline-hidden focus:outline-2 focus:outline-solid focus:outline-accent focus:-outline-offset-2 selected:font-semibold disabled:text-ink-2 disabled:italic',
});

export interface PopoverProps extends Omit<AriaPopoverProps, 'className' | 'style'> {
  readonly className?: string;
}

/** A glass popover; placement and flipping come from React Aria. */
export function Popover({ className, offset = 6, ...props }: PopoverProps): ReactNode {
  return <AriaPopover {...props} offset={offset} className={popoverStyles({ className })} />;
}

/** Opens a {@link Popover} from a trigger; controlled or uncontrolled. */
export function PopoverTrigger(props: DialogTriggerProps): ReactNode {
  return <DialogTrigger {...props} />;
}

export interface PopoverDialogProps extends Omit<AriaDialogProps, 'className' | 'style'> {
  readonly 'aria-label': string;
  readonly className?: string;
}

/**
 * The content of a freestanding popover: a non-modal dialog, so Escape closes
 * it and focus returns to the trigger.
 */
export function PopoverDialog({ className, ...props }: PopoverDialogProps): ReactNode {
  return (
    <AriaDialog {...props} className={cn('flex flex-col gap-2 p-2 outline-hidden', className)} />
  );
}

export interface OptionProps extends Omit<
  AriaListBoxItemProps,
  'className' | 'style' | 'children'
> {
  readonly children: ReactNode;
  readonly className?: string;
}

/** A list option showing a check mark when selected. */
export function Option({ children, className, ...props }: OptionProps): ReactNode {
  return (
    <AriaListBoxItem
      {...props}
      {...(props.textValue === undefined && typeof children === 'string'
        ? { textValue: children }
        : {})}
      className={optionStyles({ className })}
    >
      {({ isSelected }) => (
        <>
          <span className="inline-flex size-4 text-accent">
            {isSelected ? <Icon name="nav.check" size={16} /> : null}
          </span>
          <span className="min-w-0 flex-1 truncate">{children}</span>
        </>
      )}
    </AriaListBoxItem>
  );
}
