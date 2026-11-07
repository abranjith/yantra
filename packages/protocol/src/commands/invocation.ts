import { z } from 'zod';

import { err, ok, type Result } from '../utils/result.js';
import { generateUlid, ULID_PATTERN } from '../utils/ulid.js';

import { executionClassFor } from './execution.js';
import { expandOptions, type ExpandedOption } from './expand.js';
import { COMMAND_REGISTRY } from './registry.js';
import type {
  CommandEntry,
  CommandRegistry,
  ExecutionClass,
  JsonValue,
  LeafEntry,
} from './schema.js';

/** True for a syntactically absolute POSIX (`/…`) or Windows (`X:\…`, `X:/…`, `\\…`) path. */
export function isAbsoluteCwd(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || /^\\\\[^\\]/.test(path);
}

/**
 * What was requested (plan §6, D13): a canonical command path, the tokens
 * after it exactly as given, and the directory it was requested from.
 * Workers are spawned shell-free from `{path, argv}`; formatting exists only
 * for display and Copy.
 */
export const CommandInvocation = z
  .object({
    invocation_id: z
      .string()
      .regex(ULID_PATTERN)
      .describe('Client-generated ULID; the idempotency key for launching (D11).'),
    path: z
      .array(z.string().min(1))
      .nonempty()
      .describe('Canonical command path, aliases resolved (e.g. ["do"] for "discover").'),
    argv: z.array(z.string()).describe('Tokens after the path, exactly as given, in order.'),
    cwd: z
      .string()
      .refine(isAbsoluteCwd, 'cwd must be an absolute path')
      .describe('Absolute working directory the invocation was requested from.'),
  })
  .strict()
  .describe('A requested command invocation.');
export type CommandInvocation = z.infer<typeof CommandInvocation>;

/** A new invocation id (ULID). */
export function createInvocationId(): string {
  return generateUlid();
}

/** Why argv does not parse, in the CLI's own vocabulary. */
export const ParseErrorCode = z.enum([
  'unknown_command',
  'group_requires_subcommand',
  'unknown_option',
  'missing_option_value',
  'missing_argument',
  'too_many_arguments',
  'invalid_choice',
  'missing_required_option',
  'help_or_version',
  'invalid_invocation',
]);
export type ParseErrorCode = z.infer<typeof ParseErrorCode>;

/** The error branch of {@link parseInvocation}; never thrown. */
export interface ParseError {
  readonly code: ParseErrorCode;
  /** Commander's message for the same input, e.g. `error: unknown option '--x'`. */
  readonly message: string;
  /** Index into argv of the offending token, when one is to blame. */
  readonly token_index?: number;
  /** The closest known command or option, when one is close. */
  readonly suggestion?: string;
}

/** One parsed, validated invocation. */
export interface ParsedInvocation {
  readonly invocation: CommandInvocation;
  readonly entry: LeafEntry;
  /** Argument values by name; an absent optional argument without a default is omitted. */
  readonly arguments: Readonly<Record<string, string | readonly string[]>>;
  /** Option values by attribute with commander defaults applied, as `opts()` returns them. */
  readonly options: Readonly<Record<string, JsonValue>>;
  /** Attributes the user actually set. */
  readonly explicit: readonly string[];
  readonly execution: ExecutionClass;
}

export interface ParseContext {
  readonly cwd: string;
  readonly invocationId?: string;
  readonly registry?: CommandRegistry;
}

interface Token {
  readonly value: string;
  readonly index: number;
}

/** A node of the command tree as commander sees it. */
interface Node {
  readonly name: string;
  readonly entry: CommandEntry | null;
  readonly children: readonly Node[];
  readonly options: readonly ExpandedOption[];
}

const VERSION_OPTION: ExpandedOption = {
  flags: '-V, --version',
  long: '--version',
  short: '-V',
  attribute: 'version',
  value: 'none',
  variadic: false,
  negatable: false,
  repeatable: false,
  description: 'output the version number',
  mandatory: false,
  input: { kind: 'bool' },
};

function buildTree(registry: CommandRegistry): Node {
  const build = (entry: CommandEntry | null, prefix: readonly string[]): Node => {
    const children = registry.commands
      .filter(
        (candidate) =>
          candidate.path.length === prefix.length + 1 &&
          prefix.every((token, index) => candidate.path[index] === token),
      )
      .map((child) => build(child, child.path));
    return {
      name: prefix.at(-1) ?? registry.program.name,
      entry,
      children,
      options:
        entry === null
          ? [VERSION_OPTION]
          : entry.kind === 'leaf'
            ? expandOptions(entry, registry.option_groups)
            : [],
    };
  };
  return build(null, []);
}

const treeCache = new WeakMap<CommandRegistry, Node>();
function treeFor(registry: CommandRegistry): Node {
  let tree = treeCache.get(registry);
  if (tree === undefined) {
    tree = buildTree(registry);
    treeCache.set(registry, tree);
  }
  return tree;
}

function findChild(node: Node, name: string | undefined): Node | undefined {
  if (name === undefined) return undefined;
  return node.children.find(
    (child) =>
      child.name === name || (child.entry?.kind === 'leaf' && child.entry.aliases.includes(name)),
  );
}

const maybeOption = (arg: string): boolean => arg.length > 1 && arg.startsWith('-');
const negativeNumber = (arg: string): boolean => /^-(\d+|\d*\.\d+)(e[+-]?\d+)?$/.test(arg);
const isLeaf = (node: Node): boolean => node.children.length === 0;

/** Levenshtein distance, for suggestions only. */
function distance(left: string, right: string): number {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let previous = row[0]!;
    row[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const current = row[j]!;
      row[j] = Math.min(
        row[j]! + 1,
        row[j - 1]! + 1,
        previous + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
      previous = current;
    }
  }
  return row[right.length]!;
}

function suggest(word: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const d = distance(word, candidate);
    if (d < bestDistance && d <= Math.max(1, Math.floor(word.length * 0.4))) {
      best = candidate;
      bestDistance = d;
    }
  }
  return best;
}

/** Internal control flow for the first parse error; never escapes {@link parseInvocation}. */
class ParseFailure extends Error {
  public readonly error: ParseError;

  public constructor(error: ParseError) {
    super(error.message);
    this.name = 'ParseFailure';
    this.error = error;
  }
}

function fail(code: ParseErrorCode, message: string, token?: Token, suggestion?: string): never {
  throw new ParseFailure({
    code,
    message,
    ...(token === undefined ? {} : { token_index: token.index }),
    ...(suggestion === undefined ? {} : { suggestion }),
  });
}

/** Option values for one node, as commander stores them. */
class OptionStore {
  public readonly values = new Map<string, JsonValue>();
  public readonly explicit = new Set<string>();

  public constructor(options: readonly ExpandedOption[]) {
    for (const option of options) {
      if (option.negatable) {
        const positive = option.long.replace(/^--no-/, '--');
        if (!options.some((candidate) => candidate.long === positive)) {
          this.values.set(option.attribute, option.default ?? true);
        }
      } else if (option.default !== undefined) {
        this.values.set(option.attribute, option.default);
      }
    }
  }

  /** Mirrors commander's `handleOptionValue`. Returns `'version'` for the version option. */
  public apply(option: ExpandedOption, raw: string | null, token: Token): 'version' | void {
    if (option === VERSION_OPTION) return 'version';
    let value: JsonValue | null = raw;
    const previous = this.values.get(option.attribute);
    const choices =
      option.input.kind === 'enum' && option.input.enforced_by === 'parser'
        ? option.input.choices
        : null;
    if (raw !== null && choices !== null) {
      if (!choices.includes(raw)) {
        fail(
          'invalid_choice',
          `error: option '${option.flags}' argument '${raw}' is invalid. Allowed choices are ${choices.join(', ')}.`,
          token,
        );
      }
    } else if (raw !== null && option.repeatable) {
      value = [...(Array.isArray(previous) ? (previous as readonly string[]) : []), raw];
    } else if (raw !== null && option.variadic) {
      value =
        previous === option.default || !Array.isArray(previous)
          ? [raw]
          : [...(previous as readonly string[]), raw];
    }
    value ??= !option.negatable;
    this.values.set(option.attribute, value);
    this.explicit.add(option.attribute);
  }
}

interface Split {
  readonly operands: Token[];
  readonly unknown: Token[];
}

/** Mirrors commander's `parseOptions` for one node. */
function parseOptionsAt(node: Node, args: readonly Token[], store: OptionStore): Split | 'version' {
  const operands: Token[] = [];
  const unknown: Token[] = [];
  let dest = operands;
  const find = (flag: string): ExpandedOption | undefined =>
    node.options.find((option) => option.long === flag || option.short === flag);

  let activeVariadic: ExpandedOption | null = null;
  let activeGroup: Token | null = null;
  let i = 0;
  while (i < args.length || activeGroup !== null) {
    const arg: Token = activeGroup ?? args[i++]!;
    activeGroup = null;
    const value = arg.value;

    if (value === '--') {
      if (dest === unknown) dest.push(arg);
      dest.push(...args.slice(i));
      break;
    }

    if (activeVariadic !== null && (!maybeOption(value) || negativeNumber(value))) {
      store.apply(activeVariadic, value, arg);
      continue;
    }
    activeVariadic = null;

    if (maybeOption(value)) {
      const option = find(value);
      if (option !== undefined) {
        if (option.value === 'required') {
          const next = args[i++];
          if (next === undefined) {
            fail('missing_option_value', `error: option '${option.flags}' argument missing`, arg);
          }
          store.apply(option, next.value, next);
        } else if (option.value === 'optional') {
          let next: string | null = null;
          const candidate = args[i];
          if (
            candidate !== undefined &&
            (!maybeOption(candidate.value) || negativeNumber(candidate.value))
          ) {
            next = candidate.value;
            i += 1;
          }
          store.apply(option, next, arg);
        } else if (store.apply(option, null, arg) === 'version') {
          return 'version';
        }
        activeVariadic = option.variadic ? option : null;
        continue;
      }
    }

    if (value.length > 2 && value.startsWith('-') && value[1] !== '-') {
      const option = find(`-${value[1]!}`);
      if (option !== undefined) {
        if (option.value !== 'none') {
          store.apply(option, value.slice(2), arg);
        } else {
          if (store.apply(option, null, arg) === 'version') return 'version';
          activeGroup = { value: `-${value.slice(2)}`, index: arg.index };
        }
        continue;
      }
    }

    if (/^--[^=]+=/.test(value)) {
      const at = value.indexOf('=');
      const option = find(value.slice(0, at));
      if (option !== undefined && option.value !== 'none') {
        store.apply(option, value.slice(at + 1), arg);
        continue;
      }
    }

    if (dest === operands && maybeOption(value) && !(isLeaf(node) && negativeNumber(value))) {
      dest = unknown;
    }
    dest.push(arg);
  }
  return { operands, unknown };
}

interface Reached {
  readonly node: Node;
  readonly path: readonly Token[];
  readonly store: OptionStore;
  readonly operands: readonly Token[];
}

const HELP_FLAGS = new Set(['-h', '--help']);

/** Mirrors commander's `_parseCommand`, from the root down to one leaf. */
function parseCommand(
  node: Node,
  operandsIn: readonly Token[],
  unknownIn: readonly Token[],
  path: readonly Token[],
): Reached {
  const store = new OptionStore(node.options);
  const parsed = parseOptionsAt(node, unknownIn, store);
  if (parsed === 'version') fail('help_or_version', 'version requested');
  const operands = [...operandsIn, ...parsed.operands];
  const unknown = parsed.unknown;
  const args = [...operands, ...unknown];

  const child = findChild(node, operands[0]?.value);
  if (child !== undefined) {
    return parseCommand(child, operands.slice(1), unknown, [...path, operands[0]!]);
  }
  const hasChildren = !isLeaf(node);
  if (hasChildren && operands[0]?.value === 'help') {
    const target = operands[1];
    if (target === undefined || findChild(node, target.value) !== undefined) {
      fail('help_or_version', 'help requested');
    }
    fail('unknown_command', `error: unknown command '${target.value}'`, target);
  }
  if (hasChildren && args.length === 0) {
    fail('group_requires_subcommand', 'a subcommand is required');
  }
  if (parsed.unknown.some((token) => HELP_FLAGS.has(token.value))) {
    fail('help_or_version', 'help requested');
  }
  for (const option of node.options) {
    if (option.mandatory && store.values.get(option.attribute) === undefined) {
      fail('missing_required_option', `error: required option '${option.flags}' not specified`);
    }
  }
  const firstUnknown = parsed.unknown[0];
  const unknownOption = (): void => {
    if (firstUnknown === undefined) return;
    const candidates = node.options.flatMap((option) => [option.long]);
    const flag = firstUnknown.value.split('=')[0]!;
    fail(
      'unknown_option',
      `error: unknown option '${firstUnknown.value}'`,
      firstUnknown,
      flag.startsWith('--') ? suggest(flag, candidates) : undefined,
    );
  };
  if (hasChildren) {
    const first = operands[0];
    if (first !== undefined) {
      const names = node.children.map((candidate) => candidate.name);
      fail(
        'unknown_command',
        `error: unknown command '${first.value}'`,
        first,
        suggest(first.value, names),
      );
    }
    unknownOption();
    fail('group_requires_subcommand', 'a subcommand is required');
  }
  unknownOption();
  return { node, path, store, operands };
}

function processArguments(
  entry: LeafEntry,
  operands: readonly Token[],
): Record<string, string | readonly string[]> {
  entry.arguments.forEach((argument, index) => {
    if (argument.required && operands[index] === undefined) {
      fail('missing_argument', `error: missing required argument '${argument.name}'`);
    }
  });
  const last = entry.arguments.at(-1);
  if (last?.variadic !== true && operands.length > entry.arguments.length) {
    const expected = entry.arguments.length;
    fail(
      'too_many_arguments',
      `error: too many arguments for '${entry.path.at(-1) ?? ''}'. Expected ${String(expected)} argument${expected === 1 ? '' : 's'} but got ${String(operands.length)}.`,
      operands[expected],
    );
  }
  const values: Record<string, string | readonly string[]> = {};
  entry.arguments.forEach((argument, index) => {
    if (argument.variadic) {
      const rest = operands.slice(index).map((token) => token.value);
      if (rest.length > 0) values[argument.name] = rest;
      else if (Array.isArray(argument.default))
        values[argument.name] = argument.default as string[];
      else if (argument.default === undefined) values[argument.name] = [];
      return;
    }
    const token = operands[index];
    if (token !== undefined) values[argument.name] = token.value;
    else if (typeof argument.default === 'string') values[argument.name] = argument.default;
  });
  return values;
}

/**
 * Parses argv (the tokens after the program name) exactly as the generated
 * commander tree would, without executing anything.
 *
 * Replicates commander 14's grammar for this registry: command resolution with
 * aliases; options before, between or after positionals; `--opt value`,
 * `--opt=value`, `-p value` and `-pvalue`; `--no-x`; repeatable and variadic
 * values; `--`; `-h`/`--help`, `help <command>` and `-V`/`--version`; parser
 * choices; mandatory options; and missing or excess arguments.
 *
 * @returns The parsed invocation, or a {@link ParseError}. Never throws.
 */
export function parseInvocation(
  argv: readonly string[],
  context: ParseContext,
): Result<ParsedInvocation, ParseError> {
  const registry = context.registry ?? COMMAND_REGISTRY;
  const tokens = argv.map((value, index) => ({ value, index }));
  try {
    const reached = parseCommand(treeFor(registry), [], tokens, []);
    const entry = reached.node.entry;
    if (entry?.kind !== 'leaf') fail('group_requires_subcommand', 'a subcommand is required');
    const args = processArguments(entry, reached.operands);

    const lastPathIndex = reached.path.at(-1)?.index ?? -1;
    const separator = tokens.find((token) => token.value === '--');
    const rest = argv.slice(lastPathIndex + 1);
    const invocationArgv =
      separator !== undefined && separator.index < lastPathIndex ? ['--', ...rest] : rest;

    const candidate = {
      invocation_id: context.invocationId ?? createInvocationId(),
      path: [...entry.path],
      argv: invocationArgv,
      cwd: context.cwd,
    };
    const invocation = CommandInvocation.safeParse(candidate);
    if (!invocation.success) {
      fail(
        'invalid_invocation',
        invocation.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; '),
      );
    }
    const options = Object.fromEntries(reached.store.values);
    const explicit = [...reached.store.explicit];
    return ok({
      invocation: invocation.data,
      entry,
      arguments: args,
      options,
      explicit,
      execution: executionClassFor(entry, { options, arguments: args, explicit }),
    });
  } catch (error) {
    if (error instanceof ParseFailure) return err(error.error);
    return err({ code: 'invalid_invocation', message: String(error) });
  }
}
