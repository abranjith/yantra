/**
 * Walks a commander tree through its public API only (`commands`, `options`,
 * `registeredArguments`, `name()`, `aliases()`, `description()`), so the
 * characterization and agreement suites never depend on commander internals.
 */

import type { Argument, Command, Option } from 'commander';

/** Whether a node is the program root, a command with subcommands, or an executable leaf. */
export type WalkedKind = 'root' | 'group' | 'leaf';

/** One command in the tree, addressed by its token path from the root. */
export interface WalkedCommand {
  readonly path: readonly string[];
  readonly kind: WalkedKind;
  readonly command: Command;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly description: string;
  readonly options: readonly Option[];
  readonly arguments: readonly Argument[];
}

/**
 * Yields the root first, then every command depth-first in registration order.
 * A command is a group when it has subcommands; otherwise it is a leaf.
 */
export function* walkCommandTree(root: Command): Generator<WalkedCommand> {
  yield describe(root, [], 'root');
  yield* walkChildren(root, []);
}

function* walkChildren(parent: Command, prefix: readonly string[]): Generator<WalkedCommand> {
  for (const child of parent.commands) {
    const path = [...prefix, child.name()];
    const kind: WalkedKind = child.commands.length > 0 ? 'group' : 'leaf';
    yield describe(child, path, kind);
    yield* walkChildren(child, path);
  }
}

function describe(command: Command, path: readonly string[], kind: WalkedKind): WalkedCommand {
  return {
    path,
    kind,
    command,
    name: command.name(),
    aliases: command.aliases(),
    description: command.description(),
    options: command.options,
    arguments: command.registeredArguments,
  };
}

/** Every command (root included) in walk order, as a flat list. */
export function listCommands(root: Command): readonly WalkedCommand[] {
  return [...walkCommandTree(root)];
}

/** The file-name form of a path: tokens joined by `__`, or `root` for the program itself. */
export function pathFileName(path: readonly string[]): string {
  return path.length === 0 ? 'root' : path.join('__');
}
