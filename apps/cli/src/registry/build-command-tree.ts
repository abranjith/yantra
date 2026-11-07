/**
 * Generates the commander tree from the command registry.
 *
 * Every rule here reproduces how the hand-written registration built a
 * command, because `--help` and parse behavior must stay byte-identical:
 * flags, descriptions and defaults; parser-enforced choices; mandatory
 * options; the `collect` parser for repeatable options; aliases; help text
 * after; and the registration style (`parent.command()` inherits settings
 * such as `showHelpAfterError`, `new Command()` plus `addCommand` does not).
 */

import {
  COMMAND_REGISTRY,
  CommandRegistryError,
  expandOptions,
  type ArgumentSpec,
  type CommandEntry,
  type CommandRegistry,
  type GroupEntry,
  type LeafEntry,
} from '@yantra/protocol';
import { Command, Option } from 'commander';

import { LEGACY_ONLY, type HandlerBinding } from './handler.js';
import { UNMIGRATED_COMMANDS, type UnmigratedCommand } from './unmigrated.js';

/** Leaf id → bound handler. A generated leaf must map to a function. */
export type HandlerTable = Readonly<Record<string, HandlerBinding | undefined>>;

/**
 * A top-level command still registered by hand. During the migration the list
 * also fixes root-help order for families that have no registry entry yet;
 * `register` is required for every name on `UNMIGRATED_COMMANDS`.
 */
export interface LegacyCommand {
  readonly name: string;
  readonly register?: (program: Command) => void;
}

/** The CLI's accumulator for repeatable options. */
export function collect(value: string, previous: readonly string[]): string[] {
  return [...previous, value];
}

function argumentToken(argument: ArgumentSpec): string {
  const name = argument.variadic ? `${argument.name}...` : argument.name;
  return argument.required ? `<${name}>` : `[${name}]`;
}

function childrenOf(registry: CommandRegistry, parent: CommandEntry): readonly CommandEntry[] {
  return registry.commands.filter(
    (entry) =>
      entry.path.length === parent.path.length + 1 &&
      entry.path.slice(0, -1).every((token, index) => token === parent.path[index]),
  );
}

function configureLeaf(
  command: Command,
  entry: LeafEntry,
  registry: CommandRegistry,
  handlers: HandlerTable,
): void {
  const bound = handlers[entry.id];
  if (bound === undefined || bound === LEGACY_ONLY) {
    throw new CommandRegistryError(
      entry.id,
      'missing-handler',
      bound === LEGACY_ONLY
        ? 'is generated but its handler is marked legacy-only'
        : 'is generated but has no handler',
    );
  }
  command.description(entry.description);
  for (const alias of entry.aliases) command.alias(alias);
  for (const argument of entry.arguments) {
    if (argument.default === undefined) {
      command.argument(argumentToken(argument), argument.description);
    } else {
      command.argument(argumentToken(argument), argument.description, argument.default);
    }
  }
  for (const spec of expandOptions(entry, registry.option_groups)) {
    const option = new Option(spec.flags, spec.description);
    if (spec.default !== undefined) option.default(spec.default);
    if (spec.input.kind === 'enum' && spec.input.enforced_by === 'parser') {
      option.choices(spec.input.choices);
    }
    if (spec.repeatable) option.argParser(collect);
    if (spec.mandatory) option.makeOptionMandatory();
    command.addOption(option);
  }
  if (entry.help_after !== undefined) command.addHelpText('after', entry.help_after);
  command.action((...params: unknown[]) => {
    const commandArg = params.at(-1) as Command;
    const options = params.at(-2) as Record<string, unknown>;
    return bound(params.slice(0, -2), options, commandArg);
  });
}

function configureGroup(
  command: Command,
  entry: GroupEntry,
  registry: CommandRegistry,
  handlers: HandlerTable,
): void {
  command.description(entry.description);
  for (const child of childrenOf(registry, entry)) attachEntry(command, child, registry, handlers);
}

/**
 * Creates and configures the command for `entry`. A `subcommand` entry is
 * created through `parent.command()` (and so attached and given the parent's
 * inherited settings); an `added` entry is created detached.
 */
function createCommand(
  parent: Command | null,
  entry: CommandEntry,
  registry: CommandRegistry,
  handlers: HandlerTable,
): Command {
  const name = entry.path.at(-1) ?? '';
  let command: Command;
  if (entry.registration === 'subcommand') {
    if (parent === null) {
      throw new CommandRegistryError(entry.id, 'missing-handler', 'is a subcommand without parent');
    }
    command = parent.command(name);
  } else {
    command = new Command(name);
  }
  if (entry.kind === 'leaf') configureLeaf(command, entry, registry, handlers);
  else configureGroup(command, entry, registry, handlers);
  return command;
}

/**
 * Creates the command for `entry` under `parent` according to its
 * registration style, configures it (recursively for groups) and returns it.
 */
export function attachEntry(
  parent: Command,
  entry: CommandEntry,
  registry: CommandRegistry,
  handlers: HandlerTable,
): Command {
  const command = createCommand(parent, entry, registry, handlers);
  if (entry.registration === 'added') parent.addCommand(command);
  return command;
}

/**
 * Builds a detached top-level command for an `added` entry, for callers that
 * compose commands themselves (command suites, `addCommand`).
 */
export function createRegisteredCommand(
  id: string,
  handlers: HandlerTable,
  registry: CommandRegistry = COMMAND_REGISTRY,
): Command {
  const entry = registry.commands.find((candidate) => candidate.id === id);
  if (entry?.registration !== 'added') {
    throw new CommandRegistryError(id, 'missing-handler', 'is not an `added` registry entry');
  }
  return createCommand(null, entry, registry, handlers);
}

/**
 * Generates the registry entry `id` under `parent`, honoring its registration
 * style, for callers that register one family themselves.
 */
export function attachRegistered(
  parent: Command,
  id: string,
  handlers: HandlerTable,
  registry: CommandRegistry = COMMAND_REGISTRY,
): Command {
  const entry = registry.commands.find((candidate) => candidate.id === id);
  if (entry === undefined) {
    throw new CommandRegistryError(id, 'missing-handler', 'has no registry entry');
  }
  return attachEntry(parent, entry, registry, handlers);
}

/**
 * Attaches every top-level command to `program`, in root-help order.
 *
 * A family on `UNMIGRATED_COMMANDS` is registered by its legacy factory; every
 * other family is generated from the registry. While some families have no
 * registry entry, `legacy` lists every top-level name in root order;
 * otherwise registry order is used.
 *
 * @throws {CommandRegistryError} when a generated leaf has no handler, or a
 * generated family has no registry entry.
 */
export function buildCommandTree(
  program: Command,
  registry: CommandRegistry,
  handlers: HandlerTable,
  legacy: readonly LegacyCommand[] = [],
  allowlist: readonly UnmigratedCommand[] = UNMIGRATED_COMMANDS,
): Command {
  const unmigrated = new Set(allowlist.map((item) => item.path));
  const topLevel = registry.commands.filter((entry) => entry.path.length === 1);
  const order = legacy.length > 0 ? legacy.map((item) => item.name) : topLevel.map((e) => e.id);

  for (const entry of topLevel) {
    if (!order.includes(entry.id)) {
      throw new CommandRegistryError(entry.id, 'missing-handler', 'has no place in root order');
    }
  }

  for (const name of order) {
    if (unmigrated.has(name)) {
      const factory = legacy.find((item) => item.name === name)?.register;
      if (factory === undefined) {
        throw new CommandRegistryError(name, 'missing-handler', 'is unmigrated but has no factory');
      }
      factory(program);
      continue;
    }
    const entry = topLevel.find((candidate) => candidate.id === name);
    if (entry === undefined) {
      throw new CommandRegistryError(name, 'missing-handler', 'is migrated but has no entry');
    }
    attachEntry(program, entry, registry, handlers);
  }
  return program;
}
