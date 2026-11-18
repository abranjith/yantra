import type { CommandInvocation, InputKind, LeafEntry } from '@yantra/protocol';
import {
  COMMAND_REGISTRY,
  createInvocationId,
  durationProblem,
  expandOptions,
  isAbsoluteCwd,
  isKnownDeadOption,
} from '@yantra/protocol/commands';

import type { OptionParity } from '../parity/types.js';

export interface FormField {
  readonly id: string;
  readonly source: 'argument' | 'option';
  readonly flag?: string;
  readonly inputKind: InputKind;
  readonly required: boolean;
  readonly defaultValue?: unknown;
  readonly choices?: readonly string[];
  readonly requires: readonly string[];
  readonly conflicts: readonly string[];
  readonly description: string;
  readonly takesValue: boolean;
  readonly repeatable: boolean;
}
export type FormValues = Readonly<Record<string, string | boolean | readonly string[] | undefined>>;
export interface DraftProblem {
  readonly field: string;
  readonly message: string;
}

export class UnsupportedFieldError extends Error {
  public override readonly name = 'UnsupportedFieldError';
}

export function deriveFields(
  command: LeafEntry,
  parity: Readonly<Record<string, OptionParity>> = {},
): FormField[] {
  const fields: FormField[] = command.arguments.map((argument) => {
    if (argument.input.kind === 'secret-input')
      throw new UnsupportedFieldError(`${command.id} ${argument.name} is a secret input`);
    return {
      id: argument.name,
      source: 'argument',
      inputKind: argument.input,
      required: argument.required,
      ...(argument.default === undefined ? {} : { defaultValue: argument.default }),
      ...(argument.input.kind === 'enum' ? { choices: argument.input.choices } : {}),
      requires: [],
      conflicts: [],
      description: argument.description,
      takesValue: true,
      repeatable: argument.variadic,
    };
  });
  for (const option of expandOptions(command, COMMAND_REGISTRY.option_groups)) {
    if (option.input.kind === 'secret-input')
      throw new UnsupportedFieldError(`${command.id} ${option.long} is a secret input`);
    if (isKnownDeadOption(command.id, option.long)) continue;
    const mapping = parity[`${command.path.join(' ')} ${option.long}`];
    if (mapping !== undefined && mapping.kind !== 'field') continue;
    const relations = command.relations.filter((relation) => relation.option === option.long);
    fields.push({
      id: option.attribute,
      source: 'option',
      flag: option.long,
      inputKind: option.input,
      required: option.mandatory,
      ...(option.default === undefined ? {} : { defaultValue: option.default }),
      ...(option.input.kind === 'enum' ? { choices: option.input.choices } : {}),
      requires: relations.filter((r) => r.kind === 'requires').flatMap((r) => r.with),
      conflicts: relations.filter((r) => r.kind === 'conflicts').flatMap((r) => r.with),
      description: option.description,
      takesValue: option.value !== 'none',
      repeatable: option.repeatable || option.variadic,
    });
  }
  return fields;
}

function isStrings(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item): item is string => typeof item === 'string');
}

function present(value: FormValues[string]): boolean {
  return (
    value === true ||
    (typeof value === 'string' && value.trim() !== '') ||
    (isStrings(value) && value.length > 0)
  );
}

export function validateDraft(fields: readonly FormField[], values: FormValues): DraftProblem[] {
  const byFlag = new Map(
    fields.filter((field) => field.flag !== undefined).map((field) => [field.flag!, field]),
  );
  const problems: DraftProblem[] = [];
  for (const field of fields) {
    const value = values[field.id];
    if (field.required && !present(value))
      problems.push({ field: field.id, message: `${field.flag ?? field.id} is required.` });
    if (!present(value)) continue;
    if (typeof value === 'string') {
      if (field.inputKind.kind === 'enum' && !field.inputKind.choices.includes(value))
        problems.push({
          field: field.id,
          message: `${field.flag ?? field.id} must be one of ${field.inputKind.choices.join(', ')}.`,
        });
      if (field.inputKind.kind === 'duration') {
        const issue = durationProblem(value, field.flag ?? field.id);
        if (issue !== null) problems.push({ field: field.id, message: issue });
      }
      if (field.inputKind.kind === 'number') {
        const n = Number(value);
        if (
          !Number.isFinite(n) ||
          (field.inputKind.integer && !Number.isInteger(n)) ||
          (field.inputKind.min !== undefined && n < field.inputKind.min)
        )
          problems.push({
            field: field.id,
            message: `${field.flag ?? field.id} is not a valid number.`,
          });
      }
      if (field.inputKind.kind === 'path' && !isAbsoluteCwd(value))
        problems.push({
          field: field.id,
          message: `${field.flag ?? field.id} must be an absolute path.`,
        });
    }
    for (const needed of field.requires) {
      const other = byFlag.get(needed);
      if (other !== undefined && !present(values[other.id]))
        problems.push({ field: field.id, message: `${field.flag} requires ${needed}.` });
    }
    for (const clash of field.conflicts) {
      const other = byFlag.get(clash);
      if (other !== undefined && present(values[other.id]))
        problems.push({ field: field.id, message: `${field.flag} conflicts with ${clash}.` });
    }
  }
  return problems;
}

export function buildInvocation(
  command: LeafEntry,
  values: FormValues,
  cwd: string,
  id: () => string = createInvocationId,
): CommandInvocation {
  if (!isAbsoluteCwd(cwd)) throw new Error('cwd must be absolute');
  const fields = deriveFields(command);
  const argv: string[] = [];
  for (const field of fields.filter((item) => item.source === 'argument')) {
    const value = values[field.id];
    if (isStrings(value)) argv.push(...value);
    else if (typeof value === 'string' && value !== '') argv.push(value);
  }
  for (const field of fields.filter((item) => item.source === 'option')) {
    const value = values[field.id];
    if (!present(value) || Object.is(value, field.defaultValue)) continue;
    if (value === true) argv.push(field.flag!);
    else if (isStrings(value)) for (const item of value) argv.push(field.flag!, item);
    else if (typeof value === 'string') argv.push(field.flag!, value);
  }
  return { invocation_id: id(), path: [...command.path], argv, cwd };
}
