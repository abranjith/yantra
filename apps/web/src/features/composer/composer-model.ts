/**
 * The composer's model (FEAT-067 TASK-010), generated from the command
 * registry so the app offers exactly what the CLI honors (memory -> General:
 * CLI ↔ app parity).
 *
 * A registry option appears only when all of these hold:
 * - it is an option of this command and applies in the current mode and
 *   values (registry `applicability`);
 * - the app surfaces it (`--json`, `--open` and `--no-color` are reviewed
 *   exemptions, protocol APP_OPTION_EXEMPTIONS);
 * - it is not a known dead control (protocol KNOWN_DEAD_OPTIONS);
 * - it is not a secret input (credentials go through Credentials, never argv).
 *
 * Values are what the user set; everything else is the effective value the
 * host resolved (`read.effective_options`), shown with its source and never
 * pinned into the command. `toInvocation` emits only user-set flags.
 * Validation uses the protocol's own grammars, so the composer refuses
 * exactly what the CLI refuses, in the same words.
 */

import type {
  CommandInvocation,
  DangerSpec,
  EffectiveOptions,
  EffectiveOptionView,
  InputKind,
  JsonValue,
  Relation,
} from '@yantra/protocol';
import {
  COMMAND_REGISTRY,
  conditionHolds,
  durationProblem,
  expandOptions,
  findLeaf,
  isAppExemptOption,
  isKnownDeadOption,
  parseInvocation,
  type InvocationFacts,
} from '@yantra/protocol/commands';

/** The commands the composer can build. */
export type ComposerPath = 'ask' | 'research' | 'do' | 'run' | 'resume';

/** A value the user set: a switch, a value, or several values (a repeatable flag). */
export type OptionValue = string | boolean | readonly string[];

/** One declared workflow parameter and its value (Run mode, TASK-012). */
export interface WorkflowParamValue {
  readonly key: string;
  readonly type: string;
  readonly required: boolean;
  readonly value: string;
}

/** What the user has entered. */
export interface ComposerValues {
  /** The goal, topic, query, workflow name or run ID. */
  readonly positional: string;
  /** User-set options by registry attribute; an absent one takes its effective value. */
  readonly options: Readonly<Record<string, OptionValue>>;
  /** Run mode: the selected workflow's declared params. */
  readonly params?: readonly WorkflowParamValue[];
}

/** One generated option field. */
export interface ComposerField {
  /** Registry attribute, e.g. `maxSources` (`llm` for `--no-llm`). */
  readonly optionName: string;
  readonly flag: string;
  readonly inputKind: InputKind;
  readonly label: string;
  readonly help: string;
  /** Whether the option takes no value (a switch). */
  readonly isSwitch: boolean;
  readonly repeatable: boolean;
  /** The user's value, or undefined when the effective value applies. */
  readonly value: OptionValue | undefined;
  /** The host-resolved effective value and source, once known. */
  readonly effective: EffectiveOptionView | null;
  readonly relations: readonly Relation[];
  readonly danger: DangerSpec | null;
}

/** A problem with what was entered. */
export interface ComposerError {
  /** The flag, `positional`, or `params.<key>`. */
  readonly field: string;
  readonly message: string;
  /** False for an advisory relation the command checks more precisely itself. */
  readonly blocking: boolean;
}

/** See the module comment. */
export interface ComposerModel {
  readonly commandPath: readonly [ComposerPath];
  readonly positional: {
    readonly name: string;
    readonly inputKind: InputKind;
    readonly value: string;
    readonly required: boolean;
    readonly help: string;
  };
  readonly fields: readonly ComposerField[];
  readonly workflowParams: readonly WorkflowParamValue[];
  readonly errors: readonly ComposerError[];
  /** The mode the options resolve to now. */
  readonly mode: 'llm' | 'deterministic';
  /** What must be confirmed before submit (dangerous command or options in use). */
  readonly dangers: readonly { readonly flag: string | null; readonly reason: string }[];
}

const ACRONYMS: Readonly<Record<string, string>> = {
  llm: 'LLM',
  url: 'URL',
  json: 'JSON',
  cmd: 'cmd',
};

/** A flag in words: `--max-sources` reads "Max sources", `--no-llm` "No LLM". */
export function flagLabel(long: string): string {
  const words = long
    .replace(/^--/u, '')
    .split('-')
    .map((word) => ACRONYMS[word] ?? word);
  const first = words[0] ?? '';
  return [first.charAt(0).toUpperCase() + first.slice(1), ...words.slice(1)].join(' ');
}

function leaf(path: ComposerPath) {
  const entry = findLeaf([path]);
  if (entry === undefined) throw new Error(`The registry has no ${path} command.`);
  return entry;
}

/** Whether a switch's flag is present, given the option's resolved value. */
function switchPresent(negatable: boolean, value: unknown): boolean {
  return negatable ? value === false : value === true;
}

function isSet(value: OptionValue | undefined): boolean {
  if (value === undefined) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.trim() !== '';
  return value.length > 0;
}

/** The facts registry conditions are evaluated against. */
function factsFor(
  path: ComposerPath,
  values: ComposerValues,
  effective: EffectiveOptions | null,
): InvocationFacts {
  const entry = leaf(path);
  const specs = expandOptions(entry, COMMAND_REGISTRY.option_groups);
  const options: Record<string, unknown> = {};
  // Commander's parse defaults first, so the form is right before effective values arrive.
  for (const spec of specs) if (spec.default !== undefined) options[spec.attribute] = spec.default;
  for (const item of effective?.options ?? []) options[item.option] = item.value;
  const explicit: string[] = [];
  for (const spec of specs) {
    const value = values.options[spec.attribute];
    if (!isSet(value)) continue;
    explicit.push(spec.attribute);
    options[spec.attribute] = spec.value === 'none' ? !spec.negatable : value;
  }
  const userLlm = values.options.llm;
  const mode =
    userLlm === true
      ? 'deterministic'
      : (effective?.mode ?? (options.llm === false ? 'deterministic' : 'llm'));
  const positional = entry.arguments[0];
  return {
    options,
    arguments: positional === undefined ? {} : { [positional.name]: values.positional },
    explicit,
    mode,
  };
}

function validate(field: ComposerField, value: OptionValue): string | null {
  const input = field.inputKind;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  switch (input.kind) {
    case 'duration':
      return durationProblem(text, field.flag);
    case 'number': {
      if (!/^-?\d+(\.\d+)?$/u.test(text)) return `${field.flag} must be a number.`;
      const number = Number(text);
      if (input.integer && !Number.isInteger(number))
        return `${field.flag} must be a whole number.`;
      if (input.min !== undefined && number < input.min) {
        return `${field.flag} must be at least ${String(input.min)}.`;
      }
      return null;
    }
    case 'enum':
      return input.choices.includes(text)
        ? null
        : `${field.flag} must be one of ${input.choices.join(', ')}.`;
    default:
      return null;
  }
}

function relationErrors(
  fields: readonly ComposerField[],
  relations: readonly Relation[],
): ComposerError[] {
  const set = new Set(fields.filter((field) => isSet(field.value)).map((field) => field.flag));
  const errors: ComposerError[] = [];
  for (const relation of relations) {
    if (!set.has(relation.option)) continue;
    if (relation.kind === 'conflicts') {
      const clash = relation.with.filter((flag) => set.has(flag));
      if (clash.length === 0) continue;
      errors.push({
        field: relation.option,
        message: relation.note ?? `${relation.option} cannot be used with ${clash.join(', ')}.`,
        // A note means the command checks a narrower rule itself; the composer only advises.
        blocking: relation.note === undefined,
      });
    } else if (!relation.with.some((flag) => set.has(flag))) {
      errors.push({
        field: relation.option,
        message: relation.note ?? `${relation.option} needs ${relation.with.join(' or ')}.`,
        blocking: relation.note === undefined,
      });
    }
  }
  return errors;
}

export interface BuildComposerInput {
  readonly path: ComposerPath;
  readonly values: ComposerValues;
  readonly effective: EffectiveOptions | null;
}

/** Builds the model; pure. See the module comment. */
export function buildComposerModel({ path, values, effective }: BuildComposerInput): ComposerModel {
  const entry = leaf(path);
  const facts = factsFor(path, values, effective);
  const byOption = new Map((effective?.options ?? []).map((item) => [item.option, item]));
  const fields: ComposerField[] = [];
  for (const spec of expandOptions(entry, COMMAND_REGISTRY.option_groups)) {
    if (spec.input.kind === 'secret-input') continue;
    if (isAppExemptOption(spec.long)) continue;
    if (isKnownDeadOption(entry.id, spec.long)) continue;
    // Run mode collects `--params` through the workflow's declared params.
    if (path === 'run' && spec.long === '--params') continue;
    if (spec.applicability?.some((condition) => !conditionHolds(condition, facts)) === true)
      continue;
    fields.push({
      optionName: spec.attribute,
      flag: spec.long,
      inputKind: spec.input,
      label: flagLabel(spec.long),
      help: spec.description,
      isSwitch: spec.value === 'none',
      repeatable: spec.repeatable,
      value: values.options[spec.attribute],
      effective: byOption.get(spec.attribute) ?? null,
      relations: entry.relations.filter(
        (relation) => relation.option === spec.long || relation.with.includes(spec.long),
      ),
      danger: spec.danger?.level === 'confirm' ? spec.danger : null,
    });
  }
  const errors: ComposerError[] = [];
  const positional = entry.arguments[0];
  if (positional?.required === true && values.positional.trim() === '') {
    errors.push({
      field: 'positional',
      message: `Enter a ${positional.name.replace(/-/gu, ' ')}.`,
      blocking: true,
    });
  }
  for (const field of fields) {
    if (field.value === undefined || !isSet(field.value)) continue;
    const problem = validate(field, field.value);
    if (problem !== null) errors.push({ field: field.flag, message: problem, blocking: true });
  }
  errors.push(...relationErrors(fields, entry.relations));
  const params = values.params ?? [];
  for (const param of params) {
    if (param.required && param.value.trim() === '') {
      errors.push({
        field: `params.${param.key}`,
        message: `Enter ${param.key}; the workflow needs it.`,
        blocking: true,
      });
    }
  }
  const dangers = [
    ...(entry.danger.level === 'confirm' ? [{ flag: null, reason: entry.danger.reason }] : []),
    ...fields
      .filter((field) => field.danger?.level === 'confirm' && isSet(field.value))
      .map((field) => ({
        flag: field.flag,
        reason: field.danger?.level === 'confirm' ? field.danger.reason : '',
      })),
  ];
  return {
    commandPath: [path],
    positional: {
      name: positional?.name ?? '',
      inputKind: positional?.input ?? { kind: 'text' },
      value: values.positional,
      required: positional?.required ?? false,
      help: positional?.description ?? '',
    },
    fields,
    workflowParams: params,
    errors,
    mode: facts.mode ?? 'llm',
    dangers,
  };
}

/** The argv tokens for the user-set values of `model`, in field order. */
export function composerArgv(model: ComposerModel): string[] {
  const options: string[] = [];
  for (const field of model.fields) {
    const value = field.value;
    if (value === undefined || !isSet(value)) continue;
    if (field.isSwitch) {
      if (value === true) options.push(field.flag);
    } else if (Array.isArray(value)) {
      for (const item of value as readonly string[]) {
        if (item.trim() !== '') options.push(field.flag, item);
      }
    } else if (typeof value === 'string') {
      options.push(field.flag, value.trim());
    }
  }
  for (const param of model.workflowParams) {
    if (param.value.trim() !== '') options.push('--params', `${param.key}=${param.value}`);
  }
  const positional = model.positional.value;
  if (positional === '') return options;
  // An operand that looks like a flag goes after `--`, so it stays an operand.
  return positional.startsWith('-') ? [...options, '--', positional] : [positional, ...options];
}

/** The invocation `model` submits; only user-set flags, never pinned defaults. */
export function toInvocation(
  model: ComposerModel,
  context: { readonly invocationId: string; readonly cwd: string },
): CommandInvocation {
  return {
    invocation_id: context.invocationId,
    path: [model.commandPath[0]],
    argv: composerArgv(model),
    cwd: context.cwd,
  };
}

/** Whether nothing blocks a submit. */
export function canSubmit(model: ComposerModel): boolean {
  return model.errors.every((error) => !error.blocking);
}

/** How a source reads beside a value. */
export function sourceText(source: EffectiveOptionView['source']): string {
  switch (source.kind) {
    case 'flag':
      return 'set here';
    case 'env':
      return `from ${source.name}`;
    case 'preference':
      return `from preference ${source.key}`;
    case 'config':
      return `from config ${source.key}`;
    case 'schedule':
      return 'from the schedule';
    case 'workflow':
      return 'from the workflow';
    case 'default':
      return 'default';
  }
}

/** An effective value in words. */
export function valueText(field: ComposerField, value: JsonValue | null): string {
  if (field.isSwitch) {
    const negatable = field.flag.startsWith('--no-');
    return switchPresent(negatable, value) ? 'on' : 'off';
  }
  if (value === null) return 'not set';
  if (Array.isArray(value)) return value.length === 0 ? 'none' : value.map(String).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * The composer values that reproduce `argv` (Run again, "Edit before
 * running"): the operand, each option the argv sets, and run params from
 * `--params key=value`. Null when the argv does not parse.
 */
export function valuesFromArgv(
  path: ComposerPath,
  argv: readonly string[],
  cwd: string,
): ComposerValues | null {
  const parsed = parseInvocation([path, ...argv], { cwd });
  if (!parsed.isOk) return null;
  const entry = parsed.value.entry;
  const specs = expandOptions(entry, COMMAND_REGISTRY.option_groups);
  const positionalName = entry.arguments[0]?.name;
  const operand = positionalName === undefined ? undefined : parsed.value.arguments[positionalName];
  const options: Record<string, OptionValue> = {};
  let params: WorkflowParamValue[] | undefined;
  for (const attribute of parsed.value.explicit) {
    const spec = specs.find((option) => option.attribute === attribute);
    if (spec === undefined) continue;
    const value = parsed.value.options[attribute];
    if (path === 'run' && spec.long === '--params') {
      const pairs = Array.isArray(value) ? value : [];
      params = pairs.flatMap((pair) => {
        if (typeof pair !== 'string' || !pair.includes('=')) return [];
        const at = pair.indexOf('=');
        return [
          { key: pair.slice(0, at), type: 'string', required: false, value: pair.slice(at + 1) },
        ];
      });
      continue;
    }
    if (spec.value === 'none') options[attribute] = true;
    else if (Array.isArray(value)) options[attribute] = value.map(String);
    else if (value !== null && value !== undefined && typeof value !== 'object')
      options[attribute] = String(value);
  }
  return {
    positional: typeof operand === 'string' ? operand : '',
    options,
    ...(params === undefined ? {} : { params }),
  };
}
