import type { ReactNode } from 'react';
import {
  Radio as AriaRadio,
  RadioGroup as AriaRadioGroup,
  type RadioGroupProps as AriaRadioGroupProps,
  type RadioProps as AriaRadioProps,
} from 'react-aria-components';

import { cn, tv } from '../lib/cn.js';

import { FieldDescription, FieldErrorText, FieldLabel, type FieldChromeProps } from './field.js';

export const radioOuterStyles = tv({
  base: 'flex size-5 shrink-0 items-center justify-center rounded-full border border-field-edge bg-sunken group-focus-visible:outline-2 group-focus-visible:outline-offset-2 group-focus-visible:outline-accent group-focus-visible:outline-solid group-invalid:border-signal-failed',
  variants: {
    selected: {
      true: 'border-accent bg-accent',
    },
    disabled: {
      true: 'border-rule bg-sunken text-ink-3',
    },
  },
});

export interface RadioGroupProps
  extends Omit<AriaRadioGroupProps, 'className' | 'style' | 'children'>, FieldChromeProps {
  readonly children: ReactNode;
  readonly className?: string;
}

/**
 * A radio group with Drshya field chrome and no implicit default selection
 * unless the caller explicitly provides `value` or `defaultValue`.
 */
export function RadioGroup({
  label,
  description,
  errorMessage,
  children,
  className,
  ...props
}: RadioGroupProps): ReactNode {
  return (
    <AriaRadioGroup {...props} className={cn('flex flex-col gap-2', className)}>
      <FieldLabel isRequired={props.isRequired === true}>{label}</FieldLabel>
      <div className="flex flex-col gap-2">{children}</div>
      {description === undefined ? null : <FieldDescription>{description}</FieldDescription>}
      <FieldErrorText>{errorMessage}</FieldErrorText>
    </AriaRadioGroup>
  );
}

export interface RadioProps extends Omit<AriaRadioProps, 'className' | 'style' | 'children'> {
  readonly children: ReactNode;
  readonly description?: string;
  readonly className?: string;
}

/** One radio option inside {@link RadioGroup}. */
export function Radio({ children, description, className, ...props }: RadioProps): ReactNode {
  return (
    <AriaRadio
      {...props}
      className={cn(
        'group flex cursor-default items-start gap-2.5 text-ink disabled:text-ink-3',
        className,
      )}
    >
      {({ isSelected, isDisabled }) => (
        <>
          <span
            aria-hidden="true"
            data-focus-indicator
            className={radioOuterStyles({
              selected: isSelected && !isDisabled,
              disabled: isDisabled,
              className: 'mt-0.5',
            })}
          >
            {isSelected ? <span className="size-2 rounded-full bg-on-accent" /> : null}
          </span>
          <span className="flex flex-col gap-0.5">
            <span className="text-caption leading-5">{children}</span>
            {description === undefined ? null : (
              <span className="text-micro text-ink-2">{description}</span>
            )}
          </span>
        </>
      )}
    </AriaRadio>
  );
}
