/**
 * Authoring helpers for registry data. They derive what commander derives —
 * `long`, `short`, `attribute`, `value`, `variadic` and `negatable` from the
 * flags string, `path` from the dotted id — so data files state only what a
 * human decides. `validateCommandRegistry` re-checks every derived field.
 */

import { parseOptionFlags } from '../flags.js';
import type {
  ArgumentSpec,
  CommandEntryInput,
  ExitCodeSpec,
  InputKind,
  OptionSpecInput,
} from '../schema.js';

type OptionExtras = Omit<
  OptionSpecInput,
  'flags' | 'long' | 'short' | 'attribute' | 'value' | 'variadic' | 'negatable' | 'description'
>;

/**
 * One option, exactly as commander registers it. `input` defaults to `bool`
 * for a switch and `text` for a value-taking option.
 */
export function option(
  flags: string,
  description: string,
  extras: Partial<OptionExtras> = {},
): OptionSpecInput {
  const parsed = parseOptionFlags(flags);
  if (parsed === null) throw new Error(`option flags "${flags}" have no long flag`);
  return {
    flags,
    long: parsed.long,
    ...(parsed.short === undefined ? {} : { short: parsed.short }),
    attribute: parsed.attribute,
    value: parsed.value,
    variadic: parsed.variadic,
    negatable: parsed.negatable,
    description,
    input: parsed.value === 'none' ? { kind: 'bool' } : { kind: 'text' },
    ...extras,
  };
}

/** A `--json` switch with commander default `false`, as most commands register it. */
export const jsonOption = (description: string): OptionSpecInput =>
  option('--json', description, { default: false });

/** A `--debug` switch with commander default `false`. */
export const debugOption = (description: string): OptionSpecInput =>
  option('--debug', description, { default: false });

/** One positional argument. */
export function argument(
  name: string,
  spec: {
    readonly description?: string;
    readonly required: boolean;
    readonly variadic?: boolean;
    readonly default?: string;
    readonly input?: InputKind;
  },
): ArgumentSpec {
  return {
    name,
    description: spec.description ?? '',
    required: spec.required,
    variadic: spec.variadic ?? false,
    ...(spec.default === undefined ? {} : { default: spec.default }),
    input: spec.input ?? { kind: 'text' },
  };
}

type LeafInput = Extract<CommandEntryInput, { kind: 'leaf' }>;
type GroupInput = Extract<CommandEntryInput, { kind: 'group' }>;

/** An executable command; `path` is derived from the dotted id. */
export function leaf<const Id extends string>(
  spec: Omit<LeafInput, 'kind' | 'path'> & { readonly id: Id },
): LeafInput & { readonly id: Id } {
  return { kind: 'leaf', path: pathOf(spec.id), ...spec };
}

/** A command with subcommands; `path` is derived from the dotted id. */
export function group<const Id extends string>(
  spec: Omit<GroupInput, 'kind' | 'path'> & { readonly id: Id },
): GroupInput & { readonly id: Id } {
  return { kind: 'group', path: pathOf(spec.id), ...spec };
}

function pathOf(id: string): [string, ...string[]] {
  const [first, ...rest] = id.split('.');
  return [first ?? '', ...rest];
}

/** Exit-code helpers in the CLI's vocabulary (memory → Error Handling). */
export const exit = {
  ok: (meaning = 'success'): ExitCodeSpec => ({ code: 0, meaning }),
  validation: (meaning: string): ExitCodeSpec => ({ code: 1, meaning }),
  execution: (meaning: string): ExitCodeSpec => ({ code: 2, meaning }),
  environment: (meaning: string): ExitCodeSpec => ({ code: 3, meaning }),
  handoff: (meaning: string): ExitCodeSpec => ({ code: 4, meaning }),
} as const;

/** Commander rejects unknown options, missing arguments and excess arguments with exit 1. */
export const PARSE_ERRORS = 'invalid arguments or options';
