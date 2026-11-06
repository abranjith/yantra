/**
 * Menu (TASK-014): React Aria's menu in the glass popover, with sections,
 * separators, submenus and destructive items that never rely on color.
 *
 * Text on glass is `ink`/`ink-2` only (spec S3), so a destructive item keeps
 * `ink` text and carries its meaning in a required icon drawn in the
 * `signal-failed` graphic color, plus its label.
 */

import type { ReactNode } from 'react';
import {
  Header,
  Menu as AriaMenu,
  MenuItem as AriaMenuItem,
  MenuSection as AriaMenuSection,
  MenuTrigger as AriaMenuTrigger,
  Separator as AriaSeparator,
  SubmenuTrigger as AriaSubmenuTrigger,
  type MenuItemProps as AriaMenuItemProps,
  type MenuProps as AriaMenuProps,
  type MenuTriggerProps as AriaMenuTriggerProps,
  type SubmenuTriggerProps as AriaSubmenuTriggerProps,
} from 'react-aria-components';

import { Icon } from '../icons/Icon.js';
import type { IconName } from '../icons/registry.js';
import { cn } from '../lib/cn.js';

import { optionStyles, Popover } from './Popover.js';

export function MenuTrigger(props: AriaMenuTriggerProps): ReactNode {
  return <AriaMenuTrigger {...props} />;
}

export function SubmenuTrigger(props: AriaSubmenuTriggerProps): ReactNode {
  return <AriaSubmenuTrigger {...props} />;
}

export interface MenuProps<T extends object> extends Omit<AriaMenuProps<T>, 'className' | 'style'> {
  readonly className?: string;
  readonly placement?: 'bottom start' | 'bottom end' | 'top start' | 'top end' | 'end top';
}

/**
 * The menu list, rendered in the glass popover. It focuses the first item on
 * open by default: otherwise React Aria focuses the menu container, which has
 * no visible focus indicator for a keyboard user.
 */
export function Menu<T extends object>({
  className,
  placement = 'bottom start',
  autoFocus = 'first',
  ...props
}: MenuProps<T>): ReactNode {
  return (
    <Popover placement={placement}>
      <AriaMenu
        {...props}
        autoFocus={autoFocus}
        className={cn('min-w-48 outline-hidden', className)}
      />
    </Popover>
  );
}

interface MenuItemBase extends Omit<
  AriaMenuItemProps,
  'className' | 'style' | 'children' | 'textValue'
> {
  readonly children: string;
  readonly className?: string;
}

/** A menu item, optionally with an icon. */
export interface StandardMenuItemProps extends MenuItemBase {
  readonly tone?: 'default';
  readonly icon?: IconName;
}

/** A destructive item: the icon is required, so meaning never rests on color. */
export interface DestructiveMenuItemProps extends MenuItemBase {
  readonly tone: 'destructive';
  readonly icon: IconName;
}

export type MenuItemProps = StandardMenuItemProps | DestructiveMenuItemProps;

export function MenuItem({
  children,
  icon,
  tone = 'default',
  className,
  ...props
}: MenuItemProps): ReactNode {
  const destructive = tone === 'destructive';
  return (
    <AriaMenuItem
      {...props}
      textValue={children}
      data-tone={tone}
      className={optionStyles({ className: cn('pr-3', className) })}
    >
      {({ hasSubmenu }) => (
        <>
          <span
            className={cn('inline-flex size-4', destructive ? 'text-signal-failed' : 'text-ink-2')}
          >
            {icon === undefined ? null : <Icon name={icon} size={16} />}
          </span>
          <span className="min-w-0 flex-1 truncate">{children}</span>
          {hasSubmenu ? <Icon name="nav.chevronRight" size={16} className="text-ink-2" /> : null}
        </>
      )}
    </AriaMenuItem>
  );
}

export interface MenuSectionProps {
  readonly title: string;
  readonly children: ReactNode;
}

/** A labelled group of items. */
export function MenuSection({ title, children }: MenuSectionProps): ReactNode {
  return (
    <AriaMenuSection className="flex flex-col">
      <Header className="type-label px-2 pt-2 pb-1 text-ink-2">{title}</Header>
      {children}
    </AriaMenuSection>
  );
}

export function MenuSeparator(): ReactNode {
  return <AriaSeparator className="mx-1 my-1 border-t border-glass-edge" />;
}
