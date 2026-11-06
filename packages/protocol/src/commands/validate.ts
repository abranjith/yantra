import { CommandRegistryError } from './errors.js';
import { expandOptions, type ExpandedOption } from './expand.js';
import { parseOptionFlags } from './flags.js';
import {
  CommandRegistry,
  type ArgumentSpec,
  type CommandEntry,
  type Condition,
  type ExecutionClass,
  type LeafEntry,
  type OptionSpec,
} from './schema.js';

/**
 * Validates a command registry: the Zod shape first, then every cross-entry
 * constraint the shape cannot express (unique ids, group structure, option
 * uniqueness after group expansion, defaults agreeing with value kinds,
 * condition and relation targets, adapter/exemption details, the `--json`
 * flag, exit codes and alias collisions).
 *
 * @returns The parsed registry with schema defaults applied.
 * @throws {CommandRegistryError} on the first violation, naming the entry and rule.
 */
export function validateCommandRegistry(input: unknown): CommandRegistry {
  precheckMissingExecution(input);
  const parsed = CommandRegistry.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new CommandRegistryError(
      entryIdForIssuePath(input, issue?.path ?? []),
      'schema',
      issue === undefined ? 'invalid registry' : `${issue.path.join('.')}: ${issue.message}`,
    );
  }
  const registry = parsed.data;
  checkOptionGroups(registry);
  checkEntries(registry);
  return registry;
}

/** A leaf without `execution` is named as such rather than as a generic schema failure. */
function precheckMissingExecution(input: unknown): void {
  if (typeof input !== 'object' || input === null) return;
  const commands = (input as { commands?: unknown }).commands;
  if (!Array.isArray(commands)) return;
  commands.forEach((command: unknown, index) => {
    if (typeof command !== 'object' || command === null) return;
    const record = command as Record<string, unknown>;
    if (record.kind === 'leaf' && record.execution === undefined) {
      throw new CommandRegistryError(
        typeof record.id === 'string' ? record.id : `commands[${String(index)}]`,
        'missing-execution',
        'every executable command needs an execution class',
      );
    }
  });
}

function entryIdForIssuePath(input: unknown, path: readonly (string | number)[]): string {
  if (path[0] !== 'commands' || typeof path[1] !== 'number') return '<registry>';
  const commands = (input as { commands?: unknown[] }).commands;
  const entry = commands?.[path[1]];
  const id = (entry as { id?: unknown } | undefined)?.id;
  return typeof id === 'string' ? id : `commands[${String(path[1])}]`;
}

function checkOptionGroups(registry: CommandRegistry): void {
  const seen = new Set<string>();
  for (const group of registry.option_groups) {
    if (seen.has(group.id)) {
      throw new CommandRegistryError(group.id, 'duplicate-option-group', 'group id is not unique');
    }
    seen.add(group.id);
    checkOptionList(`group:${group.id}`, group.options);
  }
}

function checkEntries(registry: CommandRegistry): void {
  const byId = new Map<string, CommandEntry>();
  for (const entry of registry.commands) {
    if (byId.has(entry.id)) {
      throw new CommandRegistryError(entry.id, 'duplicate-id', 'id is not unique');
    }
    if (entry.id !== entry.path.join('.')) {
      throw new CommandRegistryError(
        entry.id,
        'id-path-mismatch',
        `id must equal path.join('.') ("${entry.path.join('.')}")`,
      );
    }
    if (entry.path.length > 1) {
      const parent = byId.get(entry.path.slice(0, -1).join('.'));
      if (parent?.kind !== 'group') {
        throw new CommandRegistryError(
          entry.id,
          'orphan-subcommand',
          `its parent "${entry.path.slice(0, -1).join(' ')}" must be a group listed before it`,
        );
      }
    }
    byId.set(entry.id, entry);
  }

  for (const entry of registry.commands) {
    const children = registry.commands.filter(
      (candidate) =>
        candidate.path.length === entry.path.length + 1 &&
        candidate.path.slice(0, -1).join('.') === entry.id,
    );
    if (entry.kind === 'group' && children.length === 0) {
      throw new CommandRegistryError(entry.id, 'empty-group', 'a group needs at least one child');
    }
  }

  checkAliases(registry.commands);
  for (const entry of registry.commands) {
    if (entry.kind === 'leaf') checkLeaf(entry, registry);
  }
}

function checkAliases(commands: readonly CommandEntry[]): void {
  const siblingsOf = (entry: CommandEntry): CommandEntry[] =>
    commands.filter(
      (candidate) =>
        candidate.path.length === entry.path.length &&
        candidate.path.slice(0, -1).join('.') === entry.path.slice(0, -1).join('.'),
    );
  for (const entry of commands) {
    if (entry.kind !== 'leaf') continue;
    for (const alias of entry.aliases) {
      for (const sibling of siblingsOf(entry)) {
        const siblingAliases = sibling.kind === 'leaf' && sibling !== entry ? sibling.aliases : [];
        if (sibling.path.at(-1) === alias || siblingAliases.includes(alias)) {
          throw new CommandRegistryError(
            entry.id,
            'alias-collision',
            `alias "${alias}" collides with "${sibling.id}"`,
          );
        }
      }
    }
  }
}

function checkLeaf(entry: LeafEntry, registry: CommandRegistry): void {
  const options = expandOptions(entry, registry.option_groups);
  checkOptionList(entry.id, options);
  checkArguments(entry.id, entry.arguments);

  const conditions: Condition[] = [
    ...entry.execution.rules.map((rule) => rule.when),
    ...options.flatMap((option) => option.applicability ?? []),
  ];
  for (const condition of conditions) checkConditionTarget(entry, options, condition);

  for (const relation of entry.relations) {
    for (const long of [relation.option, ...relation.with]) {
      if (!options.some((option) => option.long === long)) {
        throw new CommandRegistryError(
          entry.id,
          'unknown-relation-target',
          `relation names "${long}", which the command does not register`,
        );
      }
    }
  }

  const classes: ExecutionClass[] = [
    entry.execution.default,
    ...entry.execution.rules.map((rule) => rule.class),
  ];
  if (classes.includes('adapter') && entry.execution.adapter === undefined) {
    throw new CommandRegistryError(entry.id, 'adapter-required', 'class adapter needs `adapter`');
  }
  if (classes.includes('exemption') && entry.execution.exemption === undefined) {
    throw new CommandRegistryError(
      entry.id,
      'exemption-required',
      'class exemption needs `exemption`',
    );
  }

  const registersJson = options.some((option) => option.long === '--json');
  if ((entry.json.flag === '--json') !== registersJson) {
    throw new CommandRegistryError(
      entry.id,
      'json-flag-mismatch',
      registersJson
        ? 'the command registers --json, so json.flag must be "--json"'
        : 'json.flag is "--json" but the command does not register --json',
    );
  }

  const codes = entry.exit_codes.map((exitCode) => exitCode.code);
  if (!codes.includes(0)) {
    throw new CommandRegistryError(entry.id, 'exit-codes-missing-zero', 'exit 0 must be listed');
  }
  if (new Set(codes).size !== codes.length) {
    throw new CommandRegistryError(entry.id, 'duplicate-exit-code', 'an exit code is repeated');
  }
}

function checkConditionTarget(
  entry: LeafEntry,
  options: readonly ExpandedOption[],
  condition: Condition,
): void {
  if ('option' in condition && !options.some((option) => option.long === condition.option)) {
    throw new CommandRegistryError(
      entry.id,
      'unknown-condition-target',
      `condition names option "${condition.option}", which the command does not register`,
    );
  }
  if (
    'argument' in condition &&
    !entry.arguments.some((argument) => argument.name === condition.argument)
  ) {
    throw new CommandRegistryError(
      entry.id,
      'unknown-condition-target',
      `condition names argument "${condition.argument}", which the command does not declare`,
    );
  }
}

function checkOptionList(ownerId: string, options: readonly OptionSpec[]): void {
  const longs = new Set<string>();
  const shorts = new Set<string>();
  const attributes = new Set<string>();
  for (const option of options) {
    checkFlags(ownerId, option);
    if (longs.has(option.long) || (option.short !== undefined && shorts.has(option.short))) {
      throw new CommandRegistryError(
        ownerId,
        'duplicate-option',
        `option "${option.flags}" repeats a flag`,
      );
    }
    if (attributes.has(option.attribute)) {
      throw new CommandRegistryError(
        ownerId,
        'duplicate-option',
        `option "${option.flags}" repeats attribute "${option.attribute}"`,
      );
    }
    longs.add(option.long);
    if (option.short !== undefined) shorts.add(option.short);
    attributes.add(option.attribute);
    checkInputKind(ownerId, option);
    checkDefault(ownerId, option);
    checkPrecedence(ownerId, option);
  }
}

function checkFlags(ownerId: string, option: OptionSpec): void {
  const derived = parseOptionFlags(option.flags);
  const mismatch =
    derived === null
      ? 'flags has no long flag'
      : derived.long !== option.long
        ? `long is "${option.long}" but flags say "${derived.long}"`
        : derived.short !== option.short
          ? `short is "${String(option.short)}" but flags say "${String(derived.short)}"`
          : derived.value !== option.value
            ? `value is "${option.value}" but flags say "${derived.value}"`
            : derived.variadic !== option.variadic
              ? 'variadic disagrees with flags'
              : derived.negatable !== option.negatable
                ? 'negatable disagrees with flags'
                : derived.attribute !== option.attribute
                  ? `attribute is "${option.attribute}" but commander derives "${derived.attribute}"`
                  : null;
  if (mismatch !== null) {
    throw new CommandRegistryError(ownerId, 'flags-mismatch', `${option.flags}: ${mismatch}`);
  }
}

function checkInputKind(ownerId: string, option: OptionSpec): void {
  const takesValue = option.value !== 'none';
  if (takesValue === (option.input.kind === 'bool')) {
    throw new CommandRegistryError(
      ownerId,
      'input-kind-mismatch',
      `${option.flags}: ${takesValue ? 'a value-taking option cannot be bool' : 'a switch must use input bool'}`,
    );
  }
}

function checkDefault(ownerId: string, option: OptionSpec): void {
  const value = option.default;
  if (value === undefined) return;
  const fail = (expected: string): never => {
    throw new CommandRegistryError(
      ownerId,
      'default-type-mismatch',
      `${option.flags}: default ${JSON.stringify(value)} must be ${expected}`,
    );
  };
  if (option.value === 'none') {
    if (typeof value !== 'boolean') fail('a boolean');
    return;
  }
  if (option.repeatable || option.variadic) {
    if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
      fail('an array of strings');
    }
    return;
  }
  if (typeof value !== 'string') fail('a string (commander passes values as text)');
  if (option.input.kind === 'enum' && !option.input.choices.includes(value as string)) {
    throw new CommandRegistryError(
      ownerId,
      'enum-default-outside-choices',
      `${option.flags}: default ${JSON.stringify(value)} is not one of ${option.input.choices.join(', ')}`,
    );
  }
}

function checkPrecedence(ownerId: string, option: OptionSpec): void {
  const steps = option.precedence;
  if (steps === undefined) return;
  const sources = steps.map((step) => step.source);
  const defaultIndex = sources.indexOf('default');
  if (
    sources[0] !== 'flag' ||
    sources.lastIndexOf('flag') !== 0 ||
    (defaultIndex !== -1 && defaultIndex !== sources.length - 1)
  ) {
    throw new CommandRegistryError(
      ownerId,
      'precedence-shape',
      `${option.flags}: precedence starts with flag, names it once, and ends with at most one default`,
    );
  }
}

function checkArguments(ownerId: string, args: readonly ArgumentSpec[]): void {
  const names = new Set<string>();
  args.forEach((argument, index) => {
    if (names.has(argument.name)) {
      throw new CommandRegistryError(
        ownerId,
        'duplicate-argument',
        `argument "${argument.name}" repeats`,
      );
    }
    names.add(argument.name);
    const previous = args[index - 1];
    if (argument.required && previous !== undefined && !previous.required) {
      throw new CommandRegistryError(
        ownerId,
        'argument-order',
        `required "${argument.name}" follows an optional argument`,
      );
    }
    if (argument.variadic && index !== args.length - 1) {
      throw new CommandRegistryError(
        ownerId,
        'argument-order',
        `variadic "${argument.name}" must be last`,
      );
    }
    if (argument.default !== undefined && argument.required) {
      throw new CommandRegistryError(
        ownerId,
        'argument-default',
        `required "${argument.name}" cannot have a default`,
      );
    }
  });
}
