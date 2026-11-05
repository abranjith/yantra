import type { ReactNode } from 'react';
import { Switch as AriaSwitch, type SwitchProps as AriaSwitchProps } from 'react-aria-components';

import { Icon } from '../icons/Icon.js';
import { cn, tv } from '../lib/cn.js';

export const switchTrackStyles = tv({
  base: 'flex h-6 w-10 shrink-0 items-center rounded-full border border-field-edge bg-sunken px-0.5 transition-[background-color,border-color] duration-(--duration-quick) group-focus-visible:outline-2 group-focus-visible:outline-offset-2 group-focus-visible:outline-accent group-focus-visible:outline-solid',
  variants: {
    on: { true: 'border-accent bg-accent' },
    disabled: { true: 'border-rule' },
  },
});

export const switchThumbStyles = tv({
  base: 'flex size-4 items-center justify-center rounded-full bg-field-edge text-accent transition-transform duration-(--duration-quick)',
  variants: {
    on: { true: 'translate-x-4 bg-on-accent' },
    disabled: { true: 'bg-rule' },
  },
});

export interface SwitchProps extends Omit<AriaSwitchProps, 'className' | 'style' | 'children'> {
  readonly children: ReactNode;
  readonly className?: string;
}

/**
 * A switch: on is an Ion track, the thumb at the end, and a check mark in the
 * thumb, so state never rests on color alone. Motion is removed under reduced
 * motion. FEAT-068's GuardedSwitch builds on it.
 */
export function Switch({ children, className, ...props }: SwitchProps): ReactNode {
  return (
    <AriaSwitch
      {...props}
      className={cn(
        'group flex cursor-default items-center gap-3 text-ink disabled:text-ink-3',
        className,
      )}
    >
      {({ isSelected, isDisabled }) => (
        <>
          <span
            aria-hidden="true"
            data-focus-indicator
            className={switchTrackStyles({ on: isSelected && !isDisabled, disabled: isDisabled })}
          >
            <span className={switchThumbStyles({ on: isSelected, disabled: isDisabled })}>
              {isSelected ? <Icon name="nav.check" size={16} className="size-3" /> : null}
            </span>
          </span>
          {children}
        </>
      )}
    </AriaSwitch>
  );
}
