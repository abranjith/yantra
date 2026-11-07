import { AGENT_PROTOCOL_VERSION } from '@yantra/agent';
import { PROTOCOL_VERSION as CORE_PROTOCOL_VERSION } from '@yantra/core';
import { PROTOCOL_VERSION } from '@yantra/protocol';
import { CommanderError } from 'commander';

import { buildProgram, type CliRunOptions } from './program.js';

export { buildProgram, type CliRunOptions } from './program.js';

// Re-exported so the consolidated FEAT-015 render suite can snapshot the
// terminal Brief renderer at the same seam the CLI uses.
export { renderBriefTerminal, type BriefTerminalOptions } from './render/brief-terminal.js';
export type { BriefDetailLevel, BriefOutputFormat } from './render/types.js';

// Re-exported so the dev-only task-fidelity runner (`pnpm eval:tasks`) resolves
// its model, credentials, and budgets through the exact chain the commands use
// (flag > env > profile > pinned) instead of a copy that would drift.
export {
  resolveAgentInvocation,
  type AgentInvocation,
  type AgentInvocationDependencies,
  type AgentModelOptions,
  type AgentOptions,
} from './agent-options.js';
export { loadEffectivePreferences } from './preferences.js';
export { CLIConnectorIO } from './connector-io.js';
export { TerminalRenderer } from './render/terminal.js';
export { exitCodeForDoOutcome } from './commands/do.js';

/**
 * CLI entrypoint.
 *
 * Builds the commander program ({@link buildProgram}), parses argv, and
 * translates commander/CommanderError into the documented exit-code contract
 * (`0` success, `1` validation, `2` execution, `3` env, `4` user-handoff).
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

  const program = buildProgram(options);

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
