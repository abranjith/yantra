import type { ReactNode } from 'react';
import {
  Button as AriaButton,
  ProgressBar,
  type ButtonProps as AriaButtonProps,
} from 'react-aria-components';

import { Icon } from '../icons/Icon.js';
import type { IconName } from '../icons/registry.js';
import { focusRing, tv } from '../lib/cn.js';

/**
 * Variants spend color on meaning: `primary` is the one place to act (Ion),
 * `secondary` is a plain control, `quiet` sits in toolbars. There is no
 * decorative color variant.
 */
export const buttonStyles = tv({
  extend: focusRing,
  base: 'inline-flex shrink-0 cursor-default items-center justify-center gap-2 rounded-control border font-sans font-semibold whitespace-nowrap transition-[color,background-color,border-color] duration-(--duration-quick) disabled:pointer-events-none disabled:border-rule disabled:bg-sunken disabled:text-ink-3',
  variants: {
    variant: {
      primary:
        'border-transparent bg-accent text-on-accent hover:bg-accent-ink pressed:bg-accent-ink',
      secondary: 'border-field-edge bg-surface text-ink hover:bg-sunken pressed:bg-sunken',
      quiet:
        'border-transparent bg-transparent text-ink-2 hover:bg-sunken hover:text-ink pressed:bg-sunken',
    },
    size: {
      sm: 'h-8 px-3 text-caption',
      md: 'h-10 px-4 text-body',
    },
    iconOnly: {
      true: 'px-0',
    },
  },
  compoundVariants: [
    { size: 'sm', iconOnly: true, class: 'w-8' },
    { size: 'md', iconOnly: true, class: 'w-10' },
  ],
  defaultVariants: { variant: 'secondary', size: 'md', iconOnly: false },
});

export type ButtonVariant = 'primary' | 'secondary' | 'quiet';
export type ButtonSize = 'sm' | 'md';

interface ButtonBaseProps extends Omit<
  AriaButtonProps,
  'children' | 'className' | 'style' | 'aria-label'
> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly className?: string;
}

/** A button with a visible label, and optionally a leading icon. */
export interface LabelledButtonProps extends ButtonBaseProps {
  readonly children: ReactNode;
  readonly icon?: IconName;
  readonly 'aria-label'?: string;
}

/** An icon-only button: an accessible name is required by type. */
export interface IconButtonProps extends ButtonBaseProps {
  readonly children?: undefined;
  readonly icon: IconName;
  readonly 'aria-label': string;
}

export type ButtonProps = LabelledButtonProps | IconButtonProps;

function PendingIndicator(): ReactNode {
  return (
    <ProgressBar aria-label="Pending" isIndeterminate className="inline-flex">
      <span aria-hidden="true" className="pending-indicator inline-flex">
        <Icon name="glyph.bindu" size={16} />
      </span>
    </ProgressBar>
  );
}

/**
 * The Drshya button over React Aria's `Button`: press, keyboard and focus
 * behavior come from React Aria. `isPending` keeps the button focusable,
 * blocks presses and announces progress; under reduced motion the indicator
 * does not loop.
 */
export function Button(props: ButtonProps): ReactNode {
  const { variant, size, className, icon, children, isPending, ...rest } = props;
  const iconOnly = children === undefined;
  if (iconOnly && (props['aria-label'] ?? '').trim() === '') {
    // A developer contract, not a runtime state: an unnamed button is unusable
    // with a screen reader. Typed props already reject it; this catches casts.
    // eslint-disable-next-line no-console -- development-time contract warning
    console.warn('Drshya Button: an icon-only button needs an aria-label.');
  }
  return (
    <AriaButton
      {...rest}
      isPending={isPending === true}
      className={buttonStyles({ variant, size, iconOnly, className })}
    >
      {isPending === true ? (
        <PendingIndicator />
      ) : icon === undefined ? null : (
        <Icon name={icon} size={size === 'sm' ? 16 : 20} />
      )}
      {children}
    </AriaButton>
  );
}
