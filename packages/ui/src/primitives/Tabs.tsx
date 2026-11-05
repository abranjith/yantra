import type { ReactNode } from 'react';
import {
  Tab as AriaTab,
  TabList as AriaTabList,
  TabPanel as AriaTabPanel,
  Tabs as AriaTabs,
  type TabListProps as AriaTabListProps,
  type TabPanelProps as AriaTabPanelProps,
  type TabProps as AriaTabProps,
  type TabsProps as AriaTabsProps,
} from 'react-aria-components';

import { cn, focusRing, tv } from '../lib/cn.js';

export const tabStyles = tv({
  extend: focusRing,
  // Selection is an Ion underline AND a weight change: never color alone.
  base: '-mb-px cursor-default rounded-t-chip border-b-2 border-transparent px-1 pb-2 font-medium text-ink-2 hover:text-ink selected:border-accent selected:font-extrabold selected:text-ink disabled:text-ink-3',
});

export interface TabsProps extends Omit<AriaTabsProps, 'className' | 'style'> {
  readonly className?: string;
}

/** Tabs: arrow-key navigation and selection come from React Aria. */
export function Tabs({ className, ...props }: TabsProps): ReactNode {
  return <AriaTabs {...props} className={cn('flex flex-col gap-4', className)} />;
}

export interface TabListProps<T extends object> extends Omit<
  AriaTabListProps<T>,
  'className' | 'style'
> {
  readonly className?: string;
}

export function TabList<T extends object>({ className, ...props }: TabListProps<T>): ReactNode {
  return (
    <AriaTabList
      {...props}
      className={cn('type-label flex gap-6 border-b border-rule', className)}
    />
  );
}

export interface TabProps extends Omit<AriaTabProps, 'className' | 'style'> {
  readonly className?: string;
}

export function Tab({ className, ...props }: TabProps): ReactNode {
  return <AriaTab {...props} className={tabStyles({ className })} />;
}

export interface TabPanelProps extends Omit<AriaTabPanelProps, 'className' | 'style'> {
  readonly className?: string;
}

/** Focusable only when it holds no focusable content (React Aria default). */
export function TabPanel({ className, ...props }: TabPanelProps): ReactNode {
  return (
    <AriaTabPanel {...props} className={focusRing({ className: cn('rounded-chip', className) })} />
  );
}
