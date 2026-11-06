import type { ReactNode } from 'react';
import {
  Button as AriaButton,
  ComboBox as AriaComboBox,
  Group,
  Input,
  ListBox,
  type ComboBoxProps as AriaComboBoxProps,
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
import type { ListOption } from './Select.js';

export interface ComboBoxProps
  extends
    Omit<
      AriaComboBoxProps<ListOption>,
      'className' | 'style' | 'children' | 'items' | 'defaultItems' | 'allowsEmptyCollection'
    >,
    FieldChromeProps {
  readonly options: readonly ListOption[];
  readonly placeholder?: string;
  readonly className?: string;
}

/**
 * A combo box: type to filter (React Aria's default `contains` filter), pick
 * from a glass listbox, and see "No matches" for an empty result. Escape
 * closes the list and keeps what was typed. `allowsCustomValue` passes through.
 */
export function ComboBox({
  label,
  description,
  errorMessage,
  options,
  placeholder,
  className,
  ...props
}: ComboBoxProps): ReactNode {
  const disabledKeys: string[] = options
    .filter((option) => option.isDisabled === true)
    .map((option) => option.id);
  return (
    <AriaComboBox
      {...props}
      defaultItems={options}
      disabledKeys={disabledKeys}
      allowsEmptyCollection
      className={cn('flex flex-col gap-1.5', className)}
    >
      <FieldLabel isRequired={props.isRequired === true}>{label}</FieldLabel>
      <Group className="relative flex items-center">
        <Input
          {...(placeholder === undefined ? {} : { placeholder })}
          className={fieldInputStyles({ className: 'h-10 pr-10' })}
        />
        <AriaButton className="absolute right-1 flex size-8 items-center justify-center rounded-chip text-ink-2 hover:text-ink">
          <Icon name="nav.chevronDown" size={16} />
        </AriaButton>
      </Group>
      {description === undefined ? null : <FieldDescription>{description}</FieldDescription>}
      <FieldErrorText>{errorMessage}</FieldErrorText>
      <Popover>
        <ListBox
          className="outline-hidden"
          renderEmptyState={() => <span className="block px-2 py-1.5 text-ink-2">No matches</span>}
        >
          {(option: ListOption) => (
            <Option id={option.id} textValue={option.label}>
              {option.label}
            </Option>
          )}
        </ListBox>
      </Popover>
    </AriaComboBox>
  );
}
