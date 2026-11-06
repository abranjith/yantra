import type { ReactNode } from 'react';
import {
  Group,
  Input,
  NumberField as AriaNumberField,
  type NumberFieldProps as AriaNumberFieldProps,
} from 'react-aria-components';

import { cn } from '../lib/cn.js';

import { Button } from './Button.js';
import {
  FieldDescription,
  FieldErrorText,
  FieldLabel,
  fieldInputStyles,
  type FieldChromeProps,
} from './field.js';

export interface NumberFieldProps
  extends Omit<AriaNumberFieldProps, 'className' | 'style' | 'children'>, FieldChromeProps {
  readonly className?: string;
}

/**
 * A number field: locale formatting, min/max/step clamping and arrow-key
 * stepping come from React Aria; the stepper buttons are labelled.
 */
export function NumberField({
  label,
  description,
  errorMessage,
  className,
  ...props
}: NumberFieldProps): ReactNode {
  return (
    <AriaNumberField {...props} className={cn('flex flex-col gap-1.5', className)}>
      <FieldLabel isRequired={props.isRequired === true}>{label}</FieldLabel>
      <Group className="flex items-center gap-2">
        <Button slot="decrement" variant="secondary" icon="field.decrement" aria-label="Decrease" />
        <Input className={fieldInputStyles({ className: 'h-10 w-32 text-end tabular-nums' })} />
        <Button slot="increment" variant="secondary" icon="field.increment" aria-label="Increase" />
      </Group>
      {description === undefined ? null : <FieldDescription>{description}</FieldDescription>}
      <FieldErrorText>{errorMessage}</FieldErrorText>
    </AriaNumberField>
  );
}
