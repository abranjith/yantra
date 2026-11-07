import { COMMAND_REGISTRY, PROTOCOL_VERSION } from '@yantra/protocol';
import { Command } from 'commander';

import type { TerminalOptions } from './adapters/terminal/terminal-adapter.js';
import type { AskRuntime } from './commands/ask.js';
import type { DoRuntime } from './commands/do.js';
import type { ResearchRuntime } from './commands/research.js';
import type { SitesRuntime } from './commands/sites.js';
import type { TemplateCommandRuntime } from './commands/template.js';
import { buildCommandTree, type HandlerTable } from './registry/build-command-tree.js';
import { buildHandlers } from './registry/handlers.js';

/** Injectable runtimes for the commands that accept them (hermetic tests). */
export interface CliRunOptions {
  readonly askRuntime?: Partial<AskRuntime> & TerminalOptions;
  readonly researchRuntime?: Partial<ResearchRuntime> & TerminalOptions;
  readonly doRuntime?: Partial<DoRuntime> & TerminalOptions;
  readonly sitesRuntime?: Partial<SitesRuntime>;
  readonly templateRuntime?: Partial<TemplateCommandRuntime>;
}

/**
 * Builds the complete `yantra` commander program without parsing anything.
 * Every command is generated from the command registry (`@yantra/protocol`),
 * in root-help order, with leaves bound to {@link buildHandlers}.
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

  return buildCommandTree(program, COMMAND_REGISTRY, handlers);
}
