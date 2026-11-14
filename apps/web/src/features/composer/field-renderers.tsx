/**
 * One generated composer field per registry input kind (FEAT-067 TASK-010),
 * always a Drshya primitive:
 *
 * - text, path, run-ref → TextField (paths and IDs in the engine voice);
 * - enum → Select; bool → Switch; number → NumberField;
 * - duration → TextField, validated with the protocol duration grammar;
 * - template-ref → ComboBox over the saved templates (a tag or a Markdown
 *   path can still be typed);
 * - secret-input → never rendered (the model leaves it out).
 *
 * Under each field: its help text and the effective value with its source
 * ("from YANTRA_AGENT_MODEL", "from preference agent.model", "default").
 */

import type { InputKind } from '@yantra/protocol';
import { ComboBox, NumberField, Select, Switch, TextField } from '@yantra/ui';
import type { Key, ReactNode } from 'react';

import { sourceText, valueText, type ComposerField, type OptionValue } from './composer-model.js';

/** The help line under a field: its description and, once known, its effective value. */
export function FieldHelp({ field }: { readonly field: ComposerField }): ReactNode {
  const effective = field.effective;
  return (
    <span className="flex flex-col gap-0.5">
      <span>{field.help}</span>
      {effective === null || field.value !== undefined ? null : (
        <span data-part="effective" className="type-engine">
          {valueText(field, effective.value)} · {sourceText(effective.source)}
        </span>
      )}
    </span>
  );
}

export interface FieldRendererProps {
  readonly field: ComposerField;
  readonly onChange: (value: OptionValue | undefined) => void;
  /** Saved template names, for template-ref fields. */
  readonly templates?: readonly string[];
  readonly error?: string;
}

function textVoice(kind: InputKind['kind']): 'body' | 'engine' {
  return kind === 'path' || kind === 'run-ref' || kind === 'duration' ? 'engine' : 'body';
}

/** See the module comment. */
export function FieldRenderer({
  field,
  onChange,
  templates = [],
  error,
}: FieldRendererProps): ReactNode {
  const input = field.inputKind;
  const description = <FieldHelp field={field} />;
  const invalid = error === undefined ? {} : { isInvalid: true, errorMessage: error };
  const text = typeof field.value === 'string' ? field.value : '';

  if (field.isSwitch) {
    return (
      <div className="flex flex-col gap-1" data-field={field.flag}>
        <Switch
          isSelected={field.value === true}
          onChange={(selected) => {
            onChange(selected ? true : undefined);
          }}
        >
          {field.label}
        </Switch>
        <span className="text-caption text-ink-2">{description}</span>
      </div>
    );
  }
  if (field.repeatable) {
    const items = Array.isArray(field.value) ? (field.value as readonly string[]) : [];
    return (
      <div data-field={field.flag}>
        <TextField
          label={field.label}
          description={
            <span className="flex flex-col gap-0.5">
              {description}
              <span>One per line.</span>
            </span>
          }
          multiline
          voice="engine"
          value={items.join('\n')}
          onChange={(next) => {
            const lines = next.split('\n');
            onChange(lines.some((line) => line.trim() !== '') ? lines : undefined);
          }}
          {...invalid}
        />
      </div>
    );
  }
  switch (input.kind) {
    case 'enum':
      return (
        <div data-field={field.flag}>
          <Select
            label={field.label}
            description={description}
            options={input.choices.map((choice) => ({ id: choice, label: choice }))}
            selectedKey={text === '' ? null : text}
            placeholder="Use the effective value"
            onSelectionChange={(key: Key | null) => {
              onChange(key === null ? undefined : String(key));
            }}
            {...invalid}
          />
        </div>
      );
    case 'number':
      return (
        <div data-field={field.flag}>
          <NumberField
            label={field.label}
            description={description}
            value={text === '' ? Number.NaN : Number(text)}
            {...(input.min === undefined ? {} : { minValue: input.min })}
            {...(input.integer
              ? { formatOptions: { maximumFractionDigits: 0, useGrouping: false } }
              : { formatOptions: { useGrouping: false } })}
            onChange={(next) => {
              onChange(Number.isNaN(next) ? undefined : String(next));
            }}
            {...invalid}
          />
        </div>
      );
    case 'template-ref':
      return (
        <div data-field={field.flag}>
          <ComboBox
            label={field.label}
            description={description}
            options={templates.map((name) => ({ id: name, label: name }))}
            allowsCustomValue
            inputValue={text}
            onInputChange={(next) => {
              onChange(next === '' ? undefined : next);
            }}
            {...invalid}
          />
        </div>
      );
    default:
      return (
        <div data-field={field.flag}>
          <TextField
            label={field.label}
            description={description}
            voice={textVoice(input.kind)}
            value={text}
            onChange={(next) => {
              onChange(next === '' ? undefined : next);
            }}
            {...invalid}
          />
        </div>
      );
  }
}
