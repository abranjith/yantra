import { runTerminal } from './adapters/terminal/terminal-adapter.js';
import { type CliRunOptions } from './program.js';

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
export { CLIConnectorIO } from './adapters/terminal/connector.js';
export { TerminalRenderer } from './render/terminal.js';
export { exitCodeForDoOutcome } from './commands/do.js';

/** Compatibility entrypoint; process defaults belong to bin.ts. */
export const run = (argv: readonly string[], options: CliRunOptions = {}): Promise<number> =>
  runTerminal(argv, options);
