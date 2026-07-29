/**
 * Shared model/auth selection for the agentic commands (`ask`, `research`,
 * `do`).
 *
 * All three open exactly one provider session through `runAgenticTask()`, so
 * they must expose the *same* override surface — otherwise a user who can point
 * `do` at a local model cannot point `ask` at the same one. Registering the
 * flags and resolving them lives here so the surface cannot drift per command.
 *
 * Resolution order is explicit flag > `YANTRA_AGENT_*` environment > pinned
 * default. Invalid values are typed validation failures (exit 1), never a
 * silent fallback.
 */

import type { AgenticTaskRequest } from '@yantra/agent';
import { CommanderError, Option, type Command } from 'commander';

/** Pinned default provider when neither a flag nor the environment selects one. */
export const DEFAULT_AGENT_PROVIDER = 'anthropic';

/** Pinned default model id when neither a flag nor the environment selects one. */
export const DEFAULT_AGENT_MODEL = 'claude-haiku-4-5';

/** The shared model-selection flags parsed off any agentic command. */
export interface AgentModelOptions {
  readonly provider?: string;
  readonly model?: string;
  readonly thinking?: string;
  readonly authSecret?: string;
}

/** The resolved provider session coordinates for one agentic run. */
export interface AgentSelection {
  readonly model: AgenticTaskRequest['model'];
  readonly auth: AgenticTaskRequest['auth'];
}

/**
 * Registers the shared model-selection flags on an agentic command. Commands
 * that never start an agent session (deterministic replay, diagnostics) must
 * not call this.
 */
export function addAgentModelOptions(command: Command): Command {
  return command
    .addOption(new Option('--provider <name>', 'agent model provider (env: YANTRA_AGENT_PROVIDER)'))
    .addOption(new Option('--model <id>', 'provider-scoped model id (env: YANTRA_AGENT_MODEL)'))
    .addOption(new Option('--thinking <level>', 'provider reasoning level'))
    .addOption(new Option('--auth-secret <ref>', 'runtime model-key secret reference'));
}

/**
 * Resolves the provider/model/thinking triple for one run.
 *
 * @param command - Agentic command name, used only for the typed error code.
 */
export function selectAgentModel(
  command: string,
  options: AgentModelOptions,
  env: NodeJS.ProcessEnv,
): AgenticTaskRequest['model'] {
  const provider = clean(options.provider ?? env.YANTRA_AGENT_PROVIDER ?? DEFAULT_AGENT_PROVIDER);
  const model = clean(options.model ?? env.YANTRA_AGENT_MODEL ?? DEFAULT_AGENT_MODEL);
  if (provider.length === 0 || model.length === 0) {
    throw new CommanderError(
      1,
      `yantra.${command}.invalid-model`,
      'Provider and model must be non-empty.',
    );
  }
  const thinking = clean(options.thinking ?? '');
  return {
    provider,
    id: model,
    ...(thinking.length > 0 ? { thinking } : {}),
  };
}

/**
 * Resolves how model credentials are obtained. `--auth-secret <ref>` selects a
 * runtime-only key resolved from the keychain at session start; omitting it
 * keeps the pinned managed credential store. An explicitly blank reference is a
 * validation failure rather than a quiet downgrade to managed auth.
 */
export function selectAgentAuth(
  command: string,
  options: AgentModelOptions,
): AgenticTaskRequest['auth'] {
  if (options.authSecret === undefined) {
    return { mode: 'managed' };
  }
  const secretRef = clean(options.authSecret);
  if (secretRef.length === 0) {
    throw new CommanderError(
      1,
      `yantra.${command}.invalid-auth-secret`,
      '--auth-secret must be a non-empty secret reference.',
    );
  }
  return { mode: 'runtime-key', secretRef };
}

/**
 * Resolves both halves of an agent session selection. Commands call this once,
 * before entering any execution-failure handler, so an invalid override stays a
 * validation failure.
 */
export function selectAgentSession(
  command: string,
  options: AgentModelOptions,
  env: NodeJS.ProcessEnv,
): AgentSelection {
  return {
    model: selectAgentModel(command, options, env),
    auth: selectAgentAuth(command, options),
  };
}

function clean(value: string): string {
  return value.trim();
}
