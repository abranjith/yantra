/**
 * The all-or-nothing agentic option surface shared by every command that may
 * open a provider session. Registration and resolution live together so model,
 * credential, budget, and no-LLM vocabulary cannot drift between commands.
 *
 * Values resolve in one order: explicit flag > `YANTRA_AGENT_*` environment >
 * `profile.yaml`/preference value > pinned constant. Deterministic selection is
 * resolved first and bypasses validation for session-only options.
 */

import { readFile } from 'node:fs/promises';

import {
  DEFAULT_AGENT_BUDGETS,
  DEFAULT_AGENT_MODEL,
  DEFAULT_AGENT_PROVIDER,
  probeAgentCredential,
  type AgentCredentialProbeInput,
  type AgentBudgetConfig,
  type AgenticTaskRequest,
} from '@yantra/agent';
import { configPath, preferenceValue, type EffectivePreferences } from '@yantra/core';
import { CommanderError, Option, type Command } from 'commander';

import { noLlmReason } from './global-flags.js';

export { DEFAULT_AGENT_MODEL, DEFAULT_AGENT_PROVIDER };

/** Parsed values registered by {@link addAgentOptions}. */
export interface AgentOptions {
  readonly provider?: string;
  readonly model?: string;
  readonly thinking?: string;
  readonly authSecret?: string;
  readonly maxDuration?: string;
  readonly maxTokens?: string;
  readonly toolTimeout?: string;
  readonly toolRetries?: string;
  readonly confirmTimeout?: string;
  /** Commander stores `--no-llm` as `llm: false`. */
  readonly llm?: boolean;
}

/** Closed result of resolving the complete agentic invocation surface. */
export type AgentInvocation =
  | { readonly mode: 'no-llm'; readonly reason: 'flag' | 'env' }
  | {
      readonly mode: 'no-llm';
      readonly reason: 'unavailable';
      readonly model: AgenticTaskRequest['model'];
      readonly auth: AgenticTaskRequest['auth'];
      readonly budgets: AgentBudgetConfig;
    }
  | {
      readonly mode: 'llm';
      readonly model: AgenticTaskRequest['model'];
      readonly auth: AgenticTaskRequest['auth'];
      readonly budgets: AgentBudgetConfig;
    };

/**
 * Parses a positive duration into milliseconds.
 *
 * Accepted forms are bare milliseconds or an integer followed by `ms`, `s`,
 * `m`, or `h`. Fractional, negative, zero, blank, and unknown-unit values are
 * typed CLI validation failures.
 */
export function parseDuration(raw: string, flag: string): number {
  const match = /^([1-9]\d*)(ms|s|m|h)?$/u.exec(raw.trim());
  if (match === null) {
    throw new CommanderError(
      1,
      'yantra.agent.invalid-duration',
      `${flag} must be a positive duration such as 15m, 900s, or 900000.`,
    );
  }
  const amount = Number(match[1]);
  const multiplier =
    match[2] === 'h' ? 3_600_000 : match[2] === 'm' ? 60_000 : match[2] === 's' ? 1_000 : 1;
  const milliseconds = amount * multiplier;
  if (!Number.isSafeInteger(milliseconds)) {
    throw new CommanderError(
      1,
      'yantra.agent.invalid-duration',
      `${flag} is too large to represent safely in milliseconds.`,
    );
  }
  return milliseconds;
}

/**
 * Registers the complete shared agentic option surface. Callers must not
 * register a subset or add Commander defaults; resolution needs to distinguish
 * an absent flag from an explicitly supplied value.
 */
export function addAgentOptions(command: Command): Command {
  return command
    .addOption(new Option('--provider <name>', 'agent model provider'))
    .addOption(new Option('--model <id>', 'provider-scoped model id'))
    .addOption(new Option('--thinking <level>', 'provider reasoning level'))
    .addOption(new Option('--auth-secret <ref>', 'runtime model-key secret reference'))
    .addOption(new Option('--max-duration <duration>', 'whole-run wall-clock duration'))
    .addOption(new Option('--max-tokens <n>', 'cumulative provider token ceiling'))
    .addOption(new Option('--tool-timeout <duration>', 'timeout for one tool call'))
    .addOption(new Option('--tool-retries <n>', 'retries after an identical tool failure'))
    .addOption(new Option('--confirm-timeout <duration>', 'maximum live consent wait'))
    .addOption(new Option('--no-llm', 'force the deterministic no-model path'));
}

/**
 * Resolves one invocation using flag > environment > preference > pinned
 * precedence. The supplied preference view is already best-effort (callers use
 * `loadEffectivePreferences`); an empty map therefore cleanly selects pinned
 * defaults.
 */
/** Optional offline probe boundary for hermetic command tests. */
export interface AgentInvocationDependencies {
  readonly probeCredential?: (
    input: AgentCredentialProbeInput,
  ) => Promise<{ readonly available: boolean; readonly authSource: string }>;
  readonly personalPiAuthPath?: string;
}

export async function resolveAgentInvocation(
  command: string,
  options: AgentOptions,
  env: NodeJS.ProcessEnv,
  prefs: EffectivePreferences = new Map(),
  dependencies: AgentInvocationDependencies = {},
): Promise<AgentInvocation> {
  const deterministic = noLlmReason(options, env);
  if (deterministic !== null) return { mode: 'no-llm', reason: deterministic };

  const provider = requiredString(
    firstValue(
      options.provider,
      env.YANTRA_AGENT_PROVIDER,
      preferenceValue<unknown>(prefs, 'agent.provider', null),
      DEFAULT_AGENT_PROVIDER,
    ),
    'Provider',
    `yantra.${command}.invalid-model`,
  );
  const modelId = requiredString(
    firstValue(
      options.model,
      env.YANTRA_AGENT_MODEL,
      preferenceValue<unknown>(prefs, 'agent.model', null),
      DEFAULT_AGENT_MODEL,
    ),
    'Model',
    `yantra.${command}.invalid-model`,
  );
  const thinking = optionalString(
    firstValue(
      options.thinking,
      env.YANTRA_AGENT_THINKING,
      preferenceValue<unknown>(prefs, 'agent.thinking', null),
      null,
    ),
  );

  const authRef = firstValue(options.authSecret, env.YANTRA_AGENT_AUTH_SECRET, null, null);
  const auth: AgenticTaskRequest['auth'] =
    authRef === null
      ? { mode: 'managed' }
      : {
          mode: 'runtime-key',
          secretRef: requiredString(
            authRef,
            '--auth-secret',
            `yantra.${command}.invalid-auth-secret`,
          ),
        };

  const budgets: AgentBudgetConfig = {
    ...DEFAULT_AGENT_BUDGETS,
    wallClockMs: parseDuration(
      stringValue(
        firstValue(
          options.maxDuration,
          env.YANTRA_AGENT_MAX_DURATION,
          preferenceValue<unknown>(prefs, 'agent.max_duration', null),
          '15m',
        ),
      ),
      '--max-duration',
    ),
    maxProviderTokens: positiveInteger(
      firstValue(
        options.maxTokens,
        env.YANTRA_AGENT_MAX_TOKENS,
        preferenceValue<unknown>(prefs, 'agent.max_tokens', null),
        2_000_000,
      ),
      '--max-tokens',
    ),
    perToolTimeoutMs: parseDuration(
      stringValue(
        firstValue(
          options.toolTimeout,
          env.YANTRA_AGENT_TOOL_TIMEOUT,
          preferenceValue<unknown>(prefs, 'agent.tool_timeout', null),
          '3m',
        ),
      ),
      '--tool-timeout',
    ),
    toolRetries: nonnegativeInteger(
      firstValue(
        options.toolRetries,
        env.YANTRA_AGENT_TOOL_RETRIES,
        preferenceValue<unknown>(prefs, 'agent.tool_retries', null),
        3,
      ),
      '--tool-retries',
    ),
    confirmationWaitMs: parseDuration(
      stringValue(
        firstValue(
          options.confirmTimeout,
          env.YANTRA_AGENT_CONFIRM_TIMEOUT,
          preferenceValue<unknown>(prefs, 'agent.confirm_timeout', null),
          '3m',
        ),
      ),
      '--confirm-timeout',
    ),
  };

  const model: AgenticTaskRequest['model'] = {
    provider,
    id: modelId,
    ...(thinking === null ? {} : { thinking }),
  };
  const personalPiAuthPath = dependencies.personalPiAuthPath ?? (await readPiAuthPathOptIn());
  let credential;
  try {
    credential = await (dependencies.probeCredential
      ? dependencies.probeCredential({ provider, auth, env })
      : probeAgentCredential(
          { provider, auth, env },
          personalPiAuthPath === undefined ? {} : { personalPiAuthPath },
        ));
  } catch {
    // Availability probing is deliberately best-effort. A locked or unreadable
    // keychain selects the command's deterministic/failure path; it must not
    // become a new startup exception of its own.
    credential = { available: false, authSource: 'unavailable' } as const;
  }
  if (!credential.available) {
    return { mode: 'no-llm', reason: 'unavailable', model, auth, budgets };
  }

  return {
    mode: 'llm',
    model,
    auth,
    budgets,
  };
}

async function readPiAuthPathOptIn(): Promise<string | undefined> {
  try {
    const { parse } = await import('yaml');
    const raw = parse(await readFile(configPath(), 'utf8')) as {
      agent?: { pi_auth_path?: unknown };
    } | null;
    const path = raw?.agent?.pi_auth_path;
    return typeof path === 'string' && path.trim().length > 0 ? path.trim() : undefined;
  } catch {
    return undefined;
  }
}

function firstValue(
  flag: unknown,
  environment: unknown,
  preference: unknown,
  pinned: unknown,
): unknown {
  if (flag !== undefined) return flag;
  if (environment !== undefined) return environment;
  if (preference !== undefined && preference !== null) return preference;
  return pinned;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

function requiredString(value: unknown, label: string, code: string): string {
  const cleaned = stringValue(value).trim();
  if (cleaned.length === 0) {
    throw new CommanderError(1, code, `${label} must be non-empty.`);
  }
  return cleaned;
}

function optionalString(value: unknown): string | null {
  const cleaned = stringValue(value).trim();
  return cleaned.length === 0 ? null : cleaned;
}

function positiveInteger(value: unknown, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new CommanderError(
      1,
      'yantra.agent.invalid-budget',
      `${flag} must be a positive integer.`,
    );
  }
  return parsed;
}

function nonnegativeInteger(value: unknown, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new CommanderError(
      1,
      'yantra.agent.invalid-budget',
      `${flag} must be a non-negative integer.`,
    );
  }
  return parsed;
}
