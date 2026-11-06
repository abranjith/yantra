import { PROTOCOL_VERSION } from '@yantra/protocol';
import { Command } from 'commander';

import { registerAskCommand, type AskRuntime } from './commands/ask.js';
import { makeAuditCommand } from './commands/audit.js';
import { makeBrowserCommand } from './commands/browser.js';
import { makeConfigCommand } from './commands/config.js';
import { makeConfirmCommand } from './commands/confirm.js';
import { makeDaemonCommand } from './commands/daemon.js';
import { registerDoCommand, type DoRuntime } from './commands/do.js';
import { makeDoctorCommand } from './commands/doctor.js';
import { makeInitCommand } from './commands/init.js';
import { makeLintCommand } from './commands/lint.js';
import { makeListCommand } from './commands/list.js';
import { makeModelCommand } from './commands/model.js';
import { makeOpenCommand } from './commands/open.js';
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
import { makeSecretCommand } from './commands/secret.js';
import { makeShowCommand } from './commands/show.js';
import { makeSitesCommand, type SitesRuntime } from './commands/sites.js';
import { makeTemplateCommand, type TemplateCommandRuntime } from './commands/template.js';
import { makeUsageCommand } from './commands/usage.js';

/** Injectable runtimes for the commands that accept them (hermetic tests). */
export interface CliRunOptions {
  readonly askRuntime?: Partial<AskRuntime>;
  readonly researchRuntime?: Partial<ResearchRuntime>;
  readonly doRuntime?: Partial<DoRuntime>;
  readonly sitesRuntime?: Partial<SitesRuntime>;
  readonly templateRuntime?: Partial<TemplateCommandRuntime>;
}

/**
 * Builds the complete `yantra` commander program without parsing anything.
 *
 * The root's settings (`showHelpAfterError`) are applied before any command is
 * registered, because commands created with `program.command()` copy them at
 * creation time while commands attached with `addCommand` do not. That
 * difference is user-visible: only `ask`, `research` and `do` print help after
 * a parse error.
 */
export function buildProgram(options: CliRunOptions = {}): Command {
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
  program.addCommand(makeConfigCommand());
  program.addCommand(makeSecretCommand());
  program.addCommand(makeResumeCommand());
  program.addCommand(makeScheduleCommand());
  program.addCommand(makeSchedulesCommand());
  program.addCommand(makeUnscheduleCommand());
  program.addCommand(makeDaemonCommand());
  program.addCommand(makeLintCommand());
  program.addCommand(makeListCommand());
  program.addCommand(makeModelCommand());
  program.addCommand(makeOpenCommand());
  program.addCommand(makeShowCommand());
  program.addCommand(makeUsageCommand());
  program.addCommand(makeProfileCommand());
  program.addCommand(makePrefsCommand());
  program.addCommand(makeSitesCommand(options.sitesRuntime));
  program.addCommand(makeTemplateCommand(options.templateRuntime));
  program.addCommand(makeDoctorCommand());
  program.addCommand(makeAuditCommand());
  program.addCommand(makeReportCommand());
  program.addCommand(makeInitCommand());
  program.addCommand(makeBrowserCommand());

  return program;
}
