import { AGENT_PROTOCOL_VERSION } from '@yantra/agent';
import { CORE_PROTOCOL_VERSION } from '@yantra/core';
import { PROTOCOL_VERSION } from '@yantra/protocol';
import { Command, CommanderError } from 'commander';

import { registerAskCommand, type AskRuntime } from './commands/ask.js';
import { makeAuditCommand } from './commands/audit.js';
import { makeDoctorCommand } from './commands/doctor.js';
import { makeInitCommand } from './commands/init.js';
import { makeLintCommand } from './commands/lint.js';
import { makeListCommand } from './commands/list.js';
import { makeReportCommand } from './commands/report.js';
import { makeResumeCommand } from './commands/resume.js';
import { makeRunCommand } from './commands/run.js';
import { makeShowCommand } from './commands/show.js';

export interface CliRunOptions {
  readonly askRuntime?: Partial<AskRuntime>;
}

/**
 * CLI entrypoint.
 *
 * Registers every subcommand on a single commander program, parses argv,
 * and translates commander/CommanderError into the documented exit-code
 * contract (`0` success, `1` validation, `2` execution, `3` env, `4`
 * user-handoff).
 */
export const run = async (
  argv: readonly string[] = process.argv.slice(2),
  options: CliRunOptions = {},
): Promise<number> => {
  if (argv.length === 0) {
    process.stdout.write(
      `yantra (protocol=${PROTOCOL_VERSION}, core=${CORE_PROTOCOL_VERSION}, agent=${AGENT_PROTOCOL_VERSION})\n`,
    );
    return 0;
  }

  const program = new Command();
  program
    .name('yantra')
    .description('Yantra — AI-orchestrated browser automation, local-first')
    .version(`${PROTOCOL_VERSION} (yantra cli)`)
    .showHelpAfterError();

  registerAskCommand(program, options.askRuntime);
  program.addCommand(makeRunCommand());
  program.addCommand(makeResumeCommand());
  program.addCommand(makeLintCommand());
  program.addCommand(makeListCommand());
  program.addCommand(makeShowCommand());
  program.addCommand(makeDoctorCommand());
  program.addCommand(makeAuditCommand());
  program.addCommand(makeReportCommand());
  program.addCommand(makeInitCommand());

  try {
    await program.parseAsync([...argv], { from: 'user' });
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.code === 'commander.helpDisplayed' ? 0 : error.exitCode;
    }
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
};
