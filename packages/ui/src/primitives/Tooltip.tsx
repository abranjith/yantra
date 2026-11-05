import type { ReactNode } from 'react';
import {
  Tooltip as AriaTooltip,
  TooltipTrigger as AriaTooltipTrigger,
  type TooltipProps as AriaTooltipProps,
  type TooltipTriggerComponentProps,
} from 'react-aria-components';

import { cn } from '../lib/cn.js';

/** Open after hovering this long; keyboard focus opens at once (React Aria). */
export const TOOLTIP_DELAY_MS = 600;
export const TOOLTIP_CLOSE_DELAY_MS = 200;

export type TooltipTriggerProps = TooltipTriggerComponentProps;

/**
 * Wraps one focusable trigger and its {@link Tooltip}. A tooltip supplements
 * a name and never replaces it: the trigger keeps its own accessible name
 * (icon-only buttons carry `aria-label`). Escape dismisses it.
 */
export function TooltipTrigger({
  delay = TOOLTIP_DELAY_MS,
  closeDelay = TOOLTIP_CLOSE_DELAY_MS,
  ...props
}: TooltipTriggerProps): ReactNode {
  return <AriaTooltipTrigger delay={delay} closeDelay={closeDelay} {...props} />;
}

export interface TooltipProps extends Omit<AriaTooltipProps, 'className' | 'style' | 'children'> {
  readonly children: ReactNode;
  readonly className?: string;
}

/** A solid inverse surface (`ink` behind `surface` text), never glass. */
export function Tooltip({ offset = 6, className, children, ...props }: TooltipProps): ReactNode {
  return (
    <AriaTooltip
      {...props}
      offset={offset}
      className={cn('max-w-64 rounded-chip bg-ink px-2 py-1 text-caption text-surface', className)}
    >
      {children}
    </AriaTooltip>
  );
}
