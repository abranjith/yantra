import type { ReactNode } from 'react';
import {
  Button as AriaButton,
  ListBox,
  Select as AriaSelect,
  SelectValue,
  type SelectProps as AriaSelectProps,
} from 'react-aria-components';

import { Icon } from '../icons/Icon.js';
import { cn } from '../lib/cn.js';

import {
  FieldDescription,
  FieldErrorText,
  FieldLabel,
  fieldInputStyles,
  type FieldChromeProps,
} from './field.js';
import { Option, Popover } from './Popover.js';

/** One choice in a Select or ComboBox. */
export interface ListOption {
  readonly id: string;
  readonly label: string;
  readonly isDisabled?: boolean;
}

export interface SelectProps
  extends
    Omit<
      AriaSelectProps<ListOption>,
      'className' | 'style' | 'children' | 'items' | 'placeholder' | 'selectionMode'
    >,
    FieldChromeProps {
  readonly options: readonly ListOption[];
  /** Shown in `ink-2` while nothing is selected. */
  readonly placeholder?: string;
  readonly className?: string;
}

/**
 * A select: a field-anatomy trigger that opens a glass listbox. Enter, Space
 * and Alt+Down open it, arrow keys move, Enter selects and closes, and focus
 * returns to the trigger (React Aria).
 */
export function Select({
  label,
  description,
  errorMessage,
  options,
  placeholder = 'Select…',
  className,
  ...props
}: SelectProps): ReactNode {
  const disabledKeys: string[] = options
    .filter((option) => option.isDisabled === true)
    .map((option) => option.id);
  return (
    <AriaSelect
      {...props}
      placeholder={placeholder}
      disabledKeys={disabledKeys}
      className={cn('flex flex-col gap-1.5', className)}
    >
      <FieldLabel isRequired={props.isRequired === true}>{label}</FieldLabel>
      <AriaButton
        className={fieldInputStyles({
          className: 'flex h-10 items-center justify-between gap-2 text-start',
        })}
      >
        <SelectValue className="truncate placeholder-shown:text-ink-2" />
        <Icon name="nav.chevronDown" size={16} className="text-ink-2" />
      </AriaButton>
      {description === undefined ? null : <FieldDescription>{description}</FieldDescription>}
      <FieldErrorText>{errorMessage}</FieldErrorText>
      <Popover>
        <ListBox items={options} className="outline-hidden">
          {(option) => (
            <Option id={option.id} textValue={option.label}>
              {option.label}
            </Option>
          )}
        </ListBox>
      </Popover>
    </AriaSelect>
  );
}
