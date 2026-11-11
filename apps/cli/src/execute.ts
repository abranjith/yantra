import { AGENT_PROTOCOL_VERSION } from '@yantra/agent';
import { PROTOCOL_VERSION as CORE_PROTOCOL_VERSION, ResourceBusyError } from '@yantra/core';
import { COMMAND_REGISTRY, PROTOCOL_VERSION, executionClassFor } from '@yantra/protocol';
import { CommanderError, type Command } from 'commander';

import {
  CommandFailure,
  type CommandContext,
  type CommandResult,
  type ExitCode,
} from './context/command-context.js';
import { startRunStartSweep, type RunStartSweep } from './ownership.js';
import { buildProgram, type CliRunOptions } from './program.js';
import type { HandlerTable } from './registry/build-command-tree.js';
import { buildHandlers } from './registry/handlers.js';

/** Run the same generated command tree on any supplied surface. */
export async function executeCommand(
  argv: readonly string[],
  context: CommandContext,
  options: CliRunOptions = {},
  handlers?: HandlerTable,
): Promise<CommandResult> {
  if (argv.length === 0) {
    context.output.stdout.write(
      `yantra (protocol=${PROTOCOL_VERSION}, core=${CORE_PROTOCOL_VERSION}, agent=${AGENT_PROTOCOL_VERSION})\n`,
    );
    return { exitCode: 0 };
  }
  let result: CommandResult = { exitCode: 0 };
  let activeKind = argv[0] ?? 'command';
  let json = argv.includes('--json');
  const bindings = Object.fromEntries(
    Object.entries({ ...buildHandlers(options, context), ...handlers }).map(([id, fn]) => [
      id,
      typeof fn !== 'function'
        ? fn
        : async (args, opts, command) => {
            const entry = COMMAND_REGISTRY.commands.find((e) => e.id === id);
            let sweep: RunStartSweep | null = null;
            if (entry?.kind === 'leaf') {
              context.settings.bind(entry, command);
              activeKind = entry.id;
              json = opts.json === true || opts.format === 'json';
              // FEAT-064: a run-class command reconciles dead owners' runs in
              // the background, never delaying its own start.
              const start =
                options.runStartSweep === undefined ? startRunStartSweep : options.runStartSweep;
              if (
                start !== null &&
                executionClassFor(entry, { options: opts, arguments: {} }) === 'run'
              ) {
                sweep = start();
              }
            }
            try {
              const value = await fn(args, opts, command, context);
              if (value) result = value;
            } finally {
              await sweep?.settle();
            }
          },
    ]),
  ) as HandlerTable;
  const program = buildProgram(options, bindings);
  const configure = (command: Command): void => {
    command
      .configureOutput({
        writeOut: (value) => {
          context.output.stdout.write(value);
        },
        writeErr: (value) => {
          context.output.stderr.write(value);
        },
      })
      .exitOverride();
    for (const child of command.commands) configure(child);
  };
  configure(program);
  try {
    await program.parseAsync([...argv], { from: 'user' });
    return result;
  } catch (error) {
    if (error instanceof ResourceBusyError) {
      if (json)
        context.output.json({
          schemaVersion: '0.2',
          kind: activeKind,
          status: 'busy',
          resource: error.resource,
          holder: error.holder,
        });
      else context.output.stderr.write(`${error.message} ${error.remediation}\n`);
      return { exitCode: 3 };
    }
    if (error instanceof CommandFailure) {
      if (!error.rendered)
        context.output.stderr.write(
          `${error.message}${error.remediation ? ` ${error.remediation}` : ''}\n`,
        );
      return {
        exitCode: error.exitCode,
        failure: { code: error.code, message: error.message, remediation: error.remediation },
      };
    }
    if (error instanceof CommanderError)
      return {
        exitCode: (error.code === 'commander.helpDisplayed' ? 0 : error.exitCode) as ExitCode,
      };
    context.output.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return {
      exitCode: 2,
      failure: {
        code: 'command_failed',
        message: error instanceof Error ? error.message : String(error),
        remediation: null,
      },
    };
  }
}
