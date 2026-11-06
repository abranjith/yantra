/**
 * The shared field anatomy (TASK-012): label, description and error, over
 * React Aria's `Label`, `Text slot="description"` and `FieldError`, so every
 * form control associates them through `aria-labelledby` and
 * `aria-describedby` the same way.
 */

import type { ReactNode } from 'react';
import { FieldError, Label, Text } from 'react-aria-components';

import { Icon } from '../icons/Icon.js';
import { cn, focusRing, tv } from '../lib/cn.js';

export interface FieldLabelProps {
  readonly children: ReactNode;
  /** Shows a visible "required" word, not only an asterisk. */
  readonly isRequired?: boolean;
  readonly className?: string;
}

export function FieldLabel({ children, isRequired, className }: FieldLabelProps): ReactNode {
  return (
    <Label className={cn('type-body font-semibold text-ink', className)}>
      {children}
      {isRequired === true ? (
        <span className="ml-2 text-caption font-normal text-ink-2">required</span>
      ) : null}
    </Label>
  );
}

export function FieldDescription({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <Text slot="description" className="text-caption text-ink-2">
      {children}
    </Text>
  );
}

/** Shown only when the field is invalid; the failed icon carries meaning beyond color. */
export function FieldErrorText({ children }: { readonly children?: ReactNode }): ReactNode {
  return (
    <FieldError className="flex items-center gap-1.5 text-caption text-signal-failed-ink">
      <Icon name="outcome.failed" size={16} />
      {children}
    </FieldError>
  );
}

/**
 * A text-entry surface: sunken, with a 3:1 `field-edge` boundary (contrast
 * gate), a failed-signal border when invalid, and the keyboard focus ring.
 */
export const fieldInputStyles = tv({
  extend: focusRing,
  base: 'min-h-10 w-full rounded-control border border-field-edge bg-sunken px-3 text-body text-ink placeholder:text-ink-3 invalid:border-signal-failed disabled:border-rule disabled:text-ink-3',
  variants: {
    voice: {
      body: 'font-sans',
      engine: 'type-engine',
    },
  },
  defaultVariants: { voice: 'body' },
});

/** The props every field shares. */
export interface FieldChromeProps {
  readonly label: ReactNode;
  readonly description?: ReactNode;
  /** Shown when the field is invalid (set `isInvalid` or use validation). */
  readonly errorMessage?: ReactNode;
}
