import { AGENT_PROTOCOL_VERSION } from '@yantra/agent';
import { CORE_PROTOCOL_VERSION } from '@yantra/core';
import { PROTOCOL_VERSION } from '@yantra/protocol';
import { Command, CommanderError } from 'commander';

import { registerAskCommand, type AskRuntime } from './commands/ask.js';
import { makeAuditCommand } from './commands/audit.js';
import { makeConfirmCommand } from './commands/confirm.js';
import { makeDaemonCommand } from './commands/daemon.js';
import { registerDoCommand, type DoRuntime } from './commands/do.js';
import { makeDoctorCommand } from './commands/doctor.js';
import { makeInitCommand } from './commands/init.js';
import { makeLintCommand } from './commands/lint.js';
import { makeListCommand } from './commands/list.js';
import { makePrefsCommand } from './commands/prefs.js';
import { makeProfileCommand } from './commands/profile.js';
import { makeReportCommand } from './commands/report.js';
import { registerResearchCommand, type ResearchRuntime } from './commands/research.js';
import { makeResumeCommand } from './commands/resume.js';
import { makeRunCommand } from './commands/run.js';
import {
  makeScheduleCommand,
  makeSchedulesCommand,
  makeUnscheduleCommand,
} from './commands/schedule.js';
import { makeShowCommand } from './commands/show.js';
import { makeUsageCommand } from './commands/usage.js';

// Re-exported so the consolidated FEAT-015 render suite can snapshot the
// terminal Brief renderer at the same seam the CLI uses.
export { renderBriefTerminal, type BriefTerminalOptions } from './render/brief-terminal.js';
export type { BriefDetailLevel, BriefOutputFormat } from './render/types.js';

export interface CliRunOptions {
  readonly askRuntime?: Partial<AskRuntime>;
  readonly researchRuntime?: Partial<ResearchRuntime>;
  readonly doRuntime?: Partial<DoRuntime>;
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
  registerResearchCommand(program, options.researchRuntime);
  registerDoCommand(program, options.doRuntime);
  program.addCommand(makeRunCommand());
  program.addCommand(makeConfirmCommand());
  program.addCommand(makeResumeCommand());
  program.addCommand(makeScheduleCommand());
  program.addCommand(makeSchedulesCommand());
  program.addCommand(makeUnscheduleCommand());
  program.addCommand(makeDaemonCommand());
  program.addCommand(makeLintCommand());
  program.addCommand(makeListCommand());
  program.addCommand(makeShowCommand());
  program.addCommand(makeUsageCommand());
  program.addCommand(makeProfileCommand());
  program.addCommand(makePrefsCommand());
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
