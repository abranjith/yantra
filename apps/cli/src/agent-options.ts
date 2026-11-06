/**
 * Resolution of the agentic option surface shared by every command that may
 * open a provider session.
 *
 * Registration lives in the command registry (`@yantra/protocol`, FEAT-062) as
 * named option groups — `agent-model`, `agent-budget`, `agent-turn`, `no-llm`
 * and `screenshots` — so every command spells a flag identically and
 * registers only the groups it can honor. This module resolves what those
 * groups parse.
 *
 * Values resolve in one order: explicit flag > `YANTRA_AGENT_*` environment >
 * `profile.yaml`/preference value > pinned constant. Deterministic selection is
 * resolved first and bypasses validation for session-only options.
 */

import {
  DEFAULT_AGENT_BUDGETS,
  DEFAULT_AGENT_MODEL,
  DEFAULT_AGENT_PROVIDER,
  probeAgentCredential,
  type AgentCredentialProbeInput,
  type AgentBudgetConfig,
  type AgenticTaskRequest,
} from '@yantra/agent';
import {
  AGENT_DURATION_HINT,
  AGENT_DURATION_PATTERN,
  loadConfig,
  parseAgentCount,
  parseAgentDurationMs,
  parseAgentTurnTimeoutMs,
  preferenceValue,
  type EffectivePreferences,
} from '@yantra/core';
import { CommanderError } from 'commander';

import { noLlmReason } from './global-flags.js';

export { DEFAULT_AGENT_MODEL, DEFAULT_AGENT_PROVIDER };

/** Parsed values of the registry's `agent-model` group. */
export interface AgentModelOptions {
  readonly provider?: string;
  readonly model?: string;
  readonly thinking?: string;
  readonly authSecret?: string;
}

/** Parsed values of the `agent-budget` and `agent-turn` groups. */
export interface AgentBudgetOptions {
  readonly maxDuration?: string;
  readonly turnTimeout?: string;
  readonly maxTokens?: string;
  readonly toolTimeout?: string;
  readonly toolRetries?: string;
  readonly confirmTimeout?: string;
}

/** Parsed value of the `no-llm` group. */
export interface NoLlmOption {
  /** Commander stores `--no-llm` as `llm: false`. */
  readonly llm?: boolean;
}

/** Parsed values of the groups a full agentic run registers. */
export interface AgentOptions extends AgentModelOptions, AgentBudgetOptions, NoLlmOption {
  /** Commander stores `--no-screenshots` as `screenshots: false`. */
  readonly screenshots?: boolean;
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
      readonly thinkingSource?: 'flag' | 'environment' | 'preference' | 'default';
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
  const milliseconds = parseAgentDurationMs(raw);
  if (milliseconds !== null) return milliseconds;
  // The grammar and the safe-integer ceiling are distinct failures; a caller
  // that typed `99999999999h` needs to hear a different thing than one who
  // typed `soon`.
  throw new CommanderError(
    1,
    'yantra.agent.invalid-duration',
    AGENT_DURATION_PATTERN.test(raw.trim())
      ? `${flag} is too large to represent safely in milliseconds.`
      : `${flag} must be ${AGENT_DURATION_HINT}.`,
  );
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
    turnTimeoutMs:
      command === 'do'
        ? turnDuration(
            firstValue(
              options.turnTimeout,
              env.YANTRA_AGENT_TURN_TIMEOUT,
              preferenceValue<unknown>(prefs, 'agent.turn_timeout', null),
              '2m',
            ),
          )
        : DEFAULT_AGENT_BUDGETS.turnTimeoutMs,
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
    thinkingSource:
      options.thinking !== undefined
        ? 'flag'
        : env.YANTRA_AGENT_THINKING !== undefined
          ? 'environment'
          : preferenceValue<unknown>(prefs, 'agent.thinking', null) !== null
            ? 'preference'
            : 'default',
    model,
    auth,
    budgets,
  };
}

async function readPiAuthPathOptIn(): Promise<string | undefined> {
  const loaded = await loadConfig();
  return loaded.isOk ? (loaded.value.agent.pi_auth_path ?? undefined) : undefined;
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
  const parsed = parseAgentCount(value, { allowZero: false });
  if (parsed === null) {
    throw new CommanderError(
      1,
      'yantra.agent.invalid-budget',
      `${flag} must be a positive integer.`,
    );
  }
  return parsed;
}

function nonnegativeInteger(value: unknown, flag: string): number {
  const parsed = parseAgentCount(value, { allowZero: true });
  if (parsed === null) {
    throw new CommanderError(
      1,
      'yantra.agent.invalid-budget',
      `${flag} must be a non-negative integer.`,
    );
  }
  return parsed;
}

function turnDuration(value: unknown): number {
  const ms = parseAgentTurnTimeoutMs(value);
  if (ms !== null) return ms;
  throw new CommanderError(
    1,
    'yantra.agent.invalid-duration',
    '--turn-timeout (agent.turn_timeout) must be a duration of at least 10s.',
  );
}
