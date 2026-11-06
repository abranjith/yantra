import { COMMAND_REGISTRY, PROTOCOL_VERSION } from '@yantra/protocol';
import { Command } from 'commander';

import type { AskRuntime } from './commands/ask.js';
import { makeBrowserCommand } from './commands/browser.js';
import { makeConfigCommand } from './commands/config.js';
import { makeConfirmCommand } from './commands/confirm.js';
import { makeDaemonCommand } from './commands/daemon.js';
import type { DoRuntime } from './commands/do.js';
import { makeInitCommand } from './commands/init.js';
import { makeLintCommand } from './commands/lint.js';
import { makeModelCommand } from './commands/model.js';
import { makeOpenCommand } from './commands/open.js';
import { makePrefsCommand } from './commands/prefs.js';
import type { ResearchRuntime } from './commands/research.js';
import { makeScheduleCommand, makeUnscheduleCommand } from './commands/schedule.js';
import { makeSecretCommand } from './commands/secret.js';
import { makeSitesCommand, type SitesRuntime } from './commands/sites.js';
import { makeTemplateCommand, type TemplateCommandRuntime } from './commands/template.js';
import {
  buildCommandTree,
  type HandlerTable,
  type LegacyCommand,
} from './registry/build-command-tree.js';
import { buildHandlers } from './registry/handlers.js';

/** Injectable runtimes for the commands that accept them (hermetic tests). */
export interface CliRunOptions {
  readonly askRuntime?: Partial<AskRuntime>;
  readonly researchRuntime?: Partial<ResearchRuntime>;
  readonly doRuntime?: Partial<DoRuntime>;
  readonly sitesRuntime?: Partial<SitesRuntime>;
  readonly templateRuntime?: Partial<TemplateCommandRuntime>;
}

/**
 * Every top-level command in root-help order. Families on
 * `UNMIGRATED_COMMANDS` are registered by `register`; the rest are generated
 * from the command registry and need only their place in the order.
 */
function legacyCommands(options: CliRunOptions): readonly LegacyCommand[] {
  const added =
    (factory: () => Command) =>
    (program: Command): void => {
      program.addCommand(factory());
    };
  return [
    { name: 'ask' },
    { name: 'research' },
    { name: 'do' },
    { name: 'run' },
    { name: 'confirm', register: added(makeConfirmCommand) },
    { name: 'config', register: added(makeConfigCommand) },
    { name: 'secret', register: added(makeSecretCommand) },
    { name: 'resume' },
    { name: 'schedule', register: added(makeScheduleCommand) },
    { name: 'schedules' },
    { name: 'unschedule', register: added(makeUnscheduleCommand) },
    { name: 'daemon', register: added(makeDaemonCommand) },
    { name: 'lint', register: added(makeLintCommand) },
    { name: 'list' },
    { name: 'model', register: added(makeModelCommand) },
    { name: 'open', register: added(makeOpenCommand) },
    { name: 'show' },
    { name: 'usage' },
    { name: 'profile' },
    { name: 'prefs', register: added(makePrefsCommand) },
    { name: 'sites', register: added(() => makeSitesCommand(options.sitesRuntime)) },
    { name: 'template', register: added(() => makeTemplateCommand(options.templateRuntime)) },
    { name: 'doctor' },
    { name: 'audit' },
    { name: 'report' },
    { name: 'init', register: added(makeInitCommand) },
    { name: 'browser', register: added(makeBrowserCommand) },
  ];
}

/**
 * Builds the complete `yantra` commander program without parsing anything.
 *
 * The root's settings (`showHelpAfterError`) are applied before any command is
 * registered, because commands created with `program.command()` copy them at
 * creation time while commands attached with `addCommand` do not. That
 * difference is user-visible: only `ask`, `research` and `do` print help after
 * a parse error.
 *
 * @param handlers - The leaf handler table; tests pass recording stubs.
 */
export function buildProgram(
  options: CliRunOptions = {},
  handlers: HandlerTable = buildHandlers(options),
): Command {
  const program = new Command();
  program
    .name('yantra')
    .description(COMMAND_REGISTRY.program.description)
    .version(`${PROTOCOL_VERSION} (yantra cli)`)
    .showHelpAfterError();

  return buildCommandTree(program, COMMAND_REGISTRY, handlers, legacyCommands(options));
}
