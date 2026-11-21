import { useImperativeHandle, useRef, type KeyboardEvent, type ReactNode, type Ref } from 'react';
import { InputContext, TextField as AriaTextField } from 'react-aria-components';

import { cn } from '../lib/cn.js';

import {
  FieldDescription,
  FieldErrorText,
  FieldLabel,
  fieldInputStyles,
  type FieldChromeProps,
} from './field.js';

/** Default guidance shown on every write-only secret field. */
export const SECRET_FIELD_DESCRIPTION =
  "Stored values can't be viewed — set a new one to replace it.";

export interface SecretFieldHandle {
  /** Reads the current DOM value and clears the input synchronously. */
  readAndClear(): string;
  /** Moves focus to the underlying password input. */
  focus(): void;
}

export interface SecretFieldProps extends FieldChromeProps {
  readonly id?: string;
  readonly name?: string;
  readonly isRequired?: boolean;
  readonly isDisabled?: boolean;
  readonly isInvalid?: boolean;
  readonly placeholder?: string;
  readonly className?: string;
  readonly fieldRef?: Ref<SecretFieldHandle>;
  /**
   * Called when the user submits via Enter; receives the input value once
   * after the DOM input is synchronously cleared.
   */
  readonly onSubmit?: (value: string) => void;
}

/**
 * Write-only secret input (FEAT-071 TASK-002):
 * - Always `type="password"`, `autoComplete="off"`, `spellCheck={false}`, with no reveal toggle.
 * - Uncontrolled: never holds the secret in React state and never sets a `value` attribute.
 * - Clears the DOM input synchronously on submit / `readAndClear()`.
 */
export function SecretField({
  label,
  description = SECRET_FIELD_DESCRIPTION,
  errorMessage,
  id,
  name,
  isRequired,
  isDisabled,
  isInvalid,
  placeholder,
  className,
  fieldRef,
  onSubmit,
}: SecretFieldProps): ReactNode {
  const inputRef = useRef<HTMLInputElement | null>(null);

  function readAndClear(): string {
    const input = inputRef.current;
    if (input === null) return '';
    const value = input.value;
    input.value = '';
    return value;
  }

  useImperativeHandle(fieldRef, () => ({
    readAndClear,
    focus: () => {
      inputRef.current?.focus();
    },
  }));

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Enter' && onSubmit !== undefined) {
      event.preventDefault();
      const value = readAndClear();
      onSubmit(value);
    }
  }

  const inputClass = fieldInputStyles({ voice: 'engine', className: 'h-10' });
  const fieldProps = {
    ...(id === undefined ? {} : { id }),
    ...(name === undefined ? {} : { name }),
    ...(isRequired === undefined ? {} : { isRequired }),
    ...(isDisabled === undefined ? {} : { isDisabled }),
    ...(isInvalid === undefined ? {} : { isInvalid }),
  };

  return (
    <AriaTextField
      {...fieldProps}
      type="password"
      className={cn('flex flex-col gap-1.5', className)}
    >
      <FieldLabel isRequired={isRequired === true}>{label}</FieldLabel>
      <InputContext.Consumer>
        {(ctx) => {
          const {
            value: _value,
            defaultValue: _defaultValue,
            onChange: _onChange,
            ...safeInputProps
          } = (ctx as Record<string, unknown> | null) ?? {};
          return (
            <input
              {...safeInputProps}
              ref={inputRef}
              type="password"
              autoComplete="off"
              spellCheck={false}
              {...(placeholder === undefined ? {} : { placeholder })}
              onKeyDown={onSubmit === undefined ? undefined : handleKeyDown}
              className={inputClass}
            />
          );
        }}
      </InputContext.Consumer>
      {description === undefined ? null : <FieldDescription>{description}</FieldDescription>}
      <FieldErrorText>{errorMessage}</FieldErrorText>
    </AriaTextField>
  );
}
