/**
 * Handler binding types for the generated commander tree.
 *
 * A handler is commander-shaped — positional arguments, parsed options, the
 * command — so FEAT-072 can replace the binding with terminal and worker
 * adapters without touching the generator.
 */

import type { Command } from 'commander';

import type { CommandContext, CommandResult } from '../context/command-context.js';

/** Positional argument values in declaration order (`undefined` for an absent optional). */
export type HandlerArgs = readonly unknown[];

/** The function bound to one leaf command. */
export type Handler = ((
  args: HandlerArgs,
  options: Readonly<Record<string, unknown>>,
  command: Command,
  context?: CommandContext,
) => Promise<void | CommandResult> | void | CommandResult) & { readonly honorsAbort?: boolean };

/**
 * Marks a leaf whose top-level family is still built by its legacy factory
 * (see `UNMIGRATED_COMMANDS`). The generator never binds or calls it.
 */
export const LEGACY_ONLY: unique symbol = Symbol('legacy-only');

/** What a leaf id maps to in the handler table. */
export type HandlerBinding = Handler | typeof LEGACY_ONLY;

/**
 * Adapts a commander-style action, `(arg1, …, argN, options, command)`, into a
 * {@link Handler}. Lets a migrated family keep its action bodies verbatim.
 */
export function fromAction(
  action: (...params: never[]) => Promise<void | CommandResult> | void | CommandResult,
): Handler {
  const call = action as (
    ...params: unknown[]
  ) => Promise<void | CommandResult> | void | CommandResult;
  return (args, options, command) => call(...args, options, command);
}

/**
 * Adapts a handler that declares its own options interface. Commander passes
 * `opts()` as a plain record; each command module names the fields it reads,
 * and this is the single place that bridges the two.
 */
export function handler<TOptions extends object>(
  fn: (
    args: HandlerArgs,
    options: TOptions,
    command: Command,
  ) => Promise<void | CommandResult> | void | CommandResult,
): Handler {
  return fn as unknown as Handler;
}
