import type { ReactNode } from 'react';
import {
  Checkbox as AriaCheckbox,
  type CheckboxProps as AriaCheckboxProps,
} from 'react-aria-components';

import { Icon } from '../icons/Icon.js';
import { cn, tv } from '../lib/cn.js';

export const checkboxBoxStyles = tv({
  base: 'flex size-5 shrink-0 items-center justify-center rounded-chip border border-field-edge bg-sunken text-on-accent group-focus-visible:outline-2 group-focus-visible:outline-offset-2 group-focus-visible:outline-accent group-focus-visible:outline-solid group-invalid:border-signal-failed',
  variants: {
    checked: {
      true: 'border-accent bg-accent',
    },
    disabled: {
      true: 'border-rule bg-sunken text-ink-3',
    },
  },
});

export interface CheckboxProps extends Omit<AriaCheckboxProps, 'className' | 'style' | 'children'> {
  readonly children: ReactNode;
  readonly className?: string;
}

/**
 * A checkbox: an Ion fill with a check mark when selected, and a dash when
 * indeterminate, so state never rests on color alone.
 */
export function Checkbox({ children, className, ...props }: CheckboxProps): ReactNode {
  return (
    <AriaCheckbox
      {...props}
      className={cn(
        'group flex cursor-default items-center gap-2 text-ink disabled:text-ink-3',
        className,
      )}
    >
      {({ isSelected, isIndeterminate, isDisabled }) => (
        <>
          <span
            aria-hidden="true"
            data-focus-indicator
            className={checkboxBoxStyles({
              checked: (isSelected || isIndeterminate) && !isDisabled,
              disabled: isDisabled,
            })}
          >
            {isIndeterminate ? (
              <Icon name="field.decrement" size={16} />
            ) : isSelected ? (
              <Icon name="nav.check" size={16} />
            ) : null}
          </span>
          {children}
        </>
      )}
    </AriaCheckbox>
  );
}
