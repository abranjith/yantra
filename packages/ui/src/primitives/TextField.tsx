import type { ReactNode } from 'react';
import {
  Input,
  TextArea,
  TextField as AriaTextField,
  type TextFieldProps as AriaTextFieldProps,
} from 'react-aria-components';

import { cn } from '../lib/cn.js';

import {
  FieldDescription,
  FieldErrorText,
  FieldLabel,
  fieldInputStyles,
  type FieldChromeProps,
} from './field.js';

export interface TextFieldProps
  extends Omit<AriaTextFieldProps, 'className' | 'style' | 'children'>, FieldChromeProps {
  readonly multiline?: boolean;
  /** `engine` sets the value in the mono voice, for IDs and URLs. */
  readonly voice?: 'body' | 'engine';
  readonly placeholder?: string;
  readonly className?: string;
}

/** A single- or multi-line text field with the shared field anatomy. */
export function TextField({
  label,
  description,
  errorMessage,
  multiline = false,
  voice = 'body',
  placeholder,
  className,
  ...props
}: TextFieldProps): ReactNode {
  const input = fieldInputStyles({ voice, className: multiline ? 'min-h-24 py-2' : 'h-10' });
  const placeholderProp = placeholder === undefined ? {} : { placeholder };
  return (
    <AriaTextField {...props} className={cn('flex flex-col gap-1.5', className)}>
      <FieldLabel isRequired={props.isRequired === true}>{label}</FieldLabel>
      {multiline ? (
        <TextArea {...placeholderProp} className={input} />
      ) : (
        <Input {...placeholderProp} className={input} />
      )}
      {description === undefined ? null : <FieldDescription>{description}</FieldDescription>}
      <FieldErrorText>{errorMessage}</FieldErrorText>
    </AriaTextField>
  );
}
