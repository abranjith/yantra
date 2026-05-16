import { AGENT_PROTOCOL_VERSION } from '@yantra/agent';
import { CORE_PROTOCOL_VERSION } from '@yantra/core';
import { PROTOCOL_VERSION } from '@yantra/protocol';
import { Command, CommanderError } from 'commander';

import { registerAskCommand, type AskRuntime } from './commands/ask.js';

export interface CliRunOptions {
  readonly askRuntime?: Partial<AskRuntime>;
}

/**
 * CLI entrypoint.
 */
export const run = async (
  argv: readonly string[] = process.argv.slice(2),
  options: CliRunOptions = {},
): Promise<number> => {
  if (argv.length === 0) {
    console.log(
      `yantra (protocol=${PROTOCOL_VERSION}, core=${CORE_PROTOCOL_VERSION}, agent=${AGENT_PROTOCOL_VERSION})`,
    );
    return 0;
  }

  const program = new Command();
  program.name('yantra').description('Yantra CLI').showHelpAfterError();
  registerAskCommand(program, options.askRuntime);

  try {
    await program.parseAsync([...argv], { from: 'user' });
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.code === 'commander.helpDisplayed' ? 0 : error.exitCode;
    }
    throw error;
  }
};
