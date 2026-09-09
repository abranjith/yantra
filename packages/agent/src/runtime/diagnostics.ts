/**
 * Offline agent configuration diagnostics. These checks answer what model,
 * credential source, and budgets Yantra will use without opening a provider
 * session or exposing credential material.
 *
 * Budgets are resolved from *stored* state only — environment, `profile.yaml`,
 * then the pinned default. Per-run budget flags are deliberately not accepted:
 * doctor reports the health of what is configured, not the outcome of a
 * hypothetical run. Stored values are validated here because `profile.yaml`
 * is Zod-checked at write time but the environment is not, so a malformed
 * `YANTRA_AGENT_*` budget would otherwise be reported healthy right up until
 * every agentic command failed on it.
 */

import {
  AGENT_DURATION_HINT,
  formatAgentDuration,
  parseAgentCount,
  parseAgentDurationMs,
  type EffectivePreferences,
  type KeychainProvider,
} from '@yantra/core';

import { probePiCredential, type PiCredentialProbe } from '../adapters/pi/environment.js';
import type { AgentAuthSelection } from '../provider/types.js';

import { DEFAULT_AGENT_BUDGETS } from './orchestrator.js';

/** Pinned provider shared by CLI resolution and diagnostics. */
export const DEFAULT_AGENT_PROVIDER = 'anthropic';

/** Pinned model shared by CLI resolution and diagnostics. */
export const DEFAULT_AGENT_MODEL = 'claude-haiku-4-5';

/** Which layer supplied an effective diagnostic value. */
export type AgentOptionSource = 'flag' | 'env' | 'profile' | 'default';

/**
 * Model-selection option values accepted by offline diagnostics. Budget flags
 * are deliberately absent — see the module note.
 */
export interface AgentDiagnosticOptions {
  readonly provider?: string;
  readonly model?: string;
  readonly thinking?: string;
  readonly authSecret?: string;
  /**
   * Set when the caller selected the deterministic no-model path, naming which
   * layer selected it. Credentials are then not probed and no model is
   * reported, because none would be used.
   */
  readonly noLlm?: 'flag' | 'env';
}

/** Agent check shape composed into the core doctor report by the CLI. */
export interface AgentDoctorCheck {
  readonly id: 'agent.model' | 'agent.credentials' | 'agent.budgets';
  readonly status: 'ok' | 'warn' | 'error';
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly fixHint: string | null;
}

/** Offline credential input shared by resolution and diagnostics. */
export interface AgentCredentialProbeInput {
  readonly provider: string;
  readonly auth: AgentAuthSelection;
  readonly env: NodeJS.ProcessEnv;
}

/** Optional offline boundaries for hermetic tests and personal-store opt-in. */
export interface AgentDiagnosticDependencies {
  readonly probeCredential?: (input: AgentCredentialProbeInput) => Promise<PiCredentialProbe>;
  readonly keychain?: KeychainProvider;
  readonly dataDir?: string;
  readonly personalPiAuthPath?: string;
}

/**
 * Probes credential presence without opening a provider session. Failures are
 * converted to `unavailable`; this check must never fail a command by itself.
 */
export async function probeAgentCredential(
  input: AgentCredentialProbeInput,
  dependencies: AgentDiagnosticDependencies = {},
): Promise<PiCredentialProbe> {
  try {
    if (dependencies.probeCredential !== undefined) {
      return await dependencies.probeCredential(input);
    }
    return await probePiCredential({
      provider: input.provider,
      auth: input.auth,
      env: input.env,
      ...(dependencies.keychain ? { keychain: dependencies.keychain } : {}),
      ...(dependencies.dataDir ? { dataDir: dependencies.dataDir } : {}),
      ...(dependencies.personalPiAuthPath
        ? { personalPiAuthPath: dependencies.personalPiAuthPath }
        : {}),
    });
  } catch {
    return { available: false, authSource: 'unavailable' };
  }
}

/**
 * Returns the three agent health/configuration checks appended by `yantra
 * doctor`. Model selection resolves flag > environment > profile > pinned
 * default; budgets resolve environment > profile > pinned default and are
 * validated against the shared budget grammar.
 */
export async function runAgentDiagnostics(
  env: NodeJS.ProcessEnv,
  prefs: EffectivePreferences,
  options: AgentDiagnosticOptions = {},
  dependencies: AgentDiagnosticDependencies = {},
): Promise<readonly AgentDoctorCheck[]> {
  if (options.noLlm !== undefined) return deterministicChecks(options.noLlm);

  const provider = resolveValue(
    options.provider,
    env.YANTRA_AGENT_PROVIDER,
    preference(prefs, 'agent.provider'),
    DEFAULT_AGENT_PROVIDER,
  );
  const model = resolveValue(
    options.model,
    env.YANTRA_AGENT_MODEL,
    preference(prefs, 'agent.model'),
    DEFAULT_AGENT_MODEL,
  );
  const thinking = resolveValue(
    options.thinking,
    env.YANTRA_AGENT_THINKING,
    preference(prefs, 'agent.thinking'),
    null,
  );
  const authRef = resolveValue(options.authSecret, env.YANTRA_AGENT_AUTH_SECRET, undefined, null);
  const auth: AgentAuthSelection =
    authRef.value === null
      ? { mode: 'managed' }
      : { mode: 'runtime-key', secretRef: scalarText(authRef.value).trim() };
  const credential = await probeAgentCredential(
    { provider: scalarText(provider.value), auth, env },
    dependencies,
  );

  const duration = resolveStoredValue(
    env.YANTRA_AGENT_MAX_DURATION,
    preference(prefs, 'agent.max_duration'),
    formatAgentDuration(DEFAULT_AGENT_BUDGETS.wallClockMs),
  );
  const tokens = resolveStoredValue(
    env.YANTRA_AGENT_MAX_TOKENS,
    preference(prefs, 'agent.max_tokens'),
    DEFAULT_AGENT_BUDGETS.maxProviderTokens,
  );
  const toolTimeout = resolveStoredValue(
    env.YANTRA_AGENT_TOOL_TIMEOUT,
    preference(prefs, 'agent.tool_timeout'),
    formatAgentDuration(DEFAULT_AGENT_BUDGETS.perToolTimeoutMs),
  );
  const retries = resolveStoredValue(
    env.YANTRA_AGENT_TOOL_RETRIES,
    preference(prefs, 'agent.tool_retries'),
    DEFAULT_AGENT_BUDGETS.toolRetries,
  );
  const confirmTimeout = resolveStoredValue(
    env.YANTRA_AGENT_CONFIRM_TIMEOUT,
    preference(prefs, 'agent.confirm_timeout'),
    formatAgentDuration(DEFAULT_AGENT_BUDGETS.confirmationWaitMs),
  );
  const invalidBudgets = invalidBudgetSettings({
    duration,
    tokens,
    toolTimeout,
    retries,
    confirmTimeout,
  });

  return [
    {
      id: 'agent.model',
      status: 'ok',
      message:
        `Agent model: ${scalarText(provider.value)}/${scalarText(model.value)} ` +
        `(provider=${provider.source}, model=${model.source}, thinking=${thinking.source}).`,
      details: { provider, model, thinking },
      fixHint: null,
    },
    {
      id: 'agent.credentials',
      status: credential.available ? 'ok' : 'warn',
      message: credential.available
        ? `Agent credential source: ${credential.authSource}.`
        : `No credential is available for ${scalarText(provider.value)}/${scalarText(model.value)}.`,
      details: { authSource: credential.authSource },
      fixHint: credential.available
        ? null
        : 'Set the provider API-key environment variable, seed managed auth, or use --auth-secret <ref>.',
    },
    {
      id: 'agent.budgets',
      status: invalidBudgets.length === 0 ? 'ok' : 'error',
      message:
        invalidBudgets.length === 0
          ? `Agent budgets: duration=${scalarText(duration.value)}(${duration.source}), ` +
            `tokens=${scalarText(tokens.value)}(${tokens.source}), ` +
            `tool-timeout=${scalarText(toolTimeout.value)}(${toolTimeout.source}), ` +
            `retries=${scalarText(retries.value)}(${retries.source}), ` +
            `confirm-timeout=${scalarText(confirmTimeout.value)}(${confirmTimeout.source}).`
          : `Invalid agent budget ${invalidBudgets.length === 1 ? 'setting' : 'settings'}: ` +
            `${invalidBudgets
              .map(
                (budget) =>
                  `${budget.setting}=${JSON.stringify(budget.value)} (${budget.source}) — ` +
                  `expected ${budget.expected}`,
              )
              .join('; ')}.`,
      details: {
        duration,
        tokens,
        toolTimeout,
        retries,
        confirmTimeout,
        ...(invalidBudgets.length === 0 ? {} : { invalid: invalidBudgets }),
      },
      fixHint:
        invalidBudgets.length === 0
          ? null
          : `Correct ${invalidBudgets
              .map((budget) =>
                budget.source === 'env'
                  ? `the ${budget.envVar} environment variable`
                  : `\`yantra prefs set ${budget.preferenceKey} <value>\``,
              )
              .join(' and ')}, then retry.`,
    },
  ];
}

/**
 * The three checks reported when the deterministic path was selected. No model
 * is chosen and no credential is probed, so reporting a model or a missing
 * credential would describe a run that will not happen.
 */
function deterministicChecks(reason: 'flag' | 'env'): readonly AgentDoctorCheck[] {
  const selectedBy = reason === 'flag' ? '--no-llm' : 'LLM_PROVIDER=none';
  const suffix = `deterministic no-LLM path selected by ${selectedBy}`;
  return [
    {
      id: 'agent.model',
      status: 'ok',
      message: `No agent model will be used — ${suffix}.`,
      details: { noLlm: true, selectedBy },
      fixHint: null,
    },
    {
      id: 'agent.credentials',
      status: 'ok',
      message: `Agent credentials were not probed — ${suffix}.`,
      details: { noLlm: true, selectedBy },
      fixHint: null,
    },
    {
      id: 'agent.budgets',
      status: 'ok',
      message: `Agent budgets do not apply — ${suffix}.`,
      details: { noLlm: true, selectedBy },
      fixHint: null,
    },
  ];
}

/** One stored budget setting that no agentic command would be able to parse. */
interface InvalidBudgetSetting {
  readonly setting: string;
  readonly value: unknown;
  readonly source: AgentOptionSource;
  readonly expected: string;
  readonly envVar: string;
  readonly preferenceKey: string;
}

/**
 * Validates the resolved budgets against the shared grammar. Pinned defaults
 * are valid by construction, so anything reported here came from the
 * environment or `profile.yaml`.
 */
function invalidBudgetSettings(resolved: {
  readonly duration: ResolvedValue;
  readonly tokens: ResolvedValue;
  readonly toolTimeout: ResolvedValue;
  readonly retries: ResolvedValue;
  readonly confirmTimeout: ResolvedValue;
}): readonly InvalidBudgetSetting[] {
  const durationHint = AGENT_DURATION_HINT;
  const candidates = [
    {
      setting: 'max_duration',
      resolved: resolved.duration,
      valid: parseAgentDurationMs(resolved.duration.value) !== null,
      expected: durationHint,
      envVar: 'YANTRA_AGENT_MAX_DURATION',
      preferenceKey: 'agent.max_duration',
    },
    {
      setting: 'max_tokens',
      resolved: resolved.tokens,
      valid: parseAgentCount(resolved.tokens.value, { allowZero: false }) !== null,
      expected: 'a positive integer',
      envVar: 'YANTRA_AGENT_MAX_TOKENS',
      preferenceKey: 'agent.max_tokens',
    },
    {
      setting: 'tool_timeout',
      resolved: resolved.toolTimeout,
      valid: parseAgentDurationMs(resolved.toolTimeout.value) !== null,
      expected: durationHint,
      envVar: 'YANTRA_AGENT_TOOL_TIMEOUT',
      preferenceKey: 'agent.tool_timeout',
    },
    {
      setting: 'tool_retries',
      resolved: resolved.retries,
      valid: parseAgentCount(resolved.retries.value, { allowZero: true }) !== null,
      expected: 'a non-negative integer',
      envVar: 'YANTRA_AGENT_TOOL_RETRIES',
      preferenceKey: 'agent.tool_retries',
    },
    {
      setting: 'confirm_timeout',
      resolved: resolved.confirmTimeout,
      valid: parseAgentDurationMs(resolved.confirmTimeout.value) !== null,
      expected: durationHint,
      envVar: 'YANTRA_AGENT_CONFIRM_TIMEOUT',
      preferenceKey: 'agent.confirm_timeout',
    },
  ];

  return candidates
    .filter((candidate) => !candidate.valid)
    .map((candidate) => ({
      setting: candidate.setting,
      value: candidate.resolved.value,
      source: candidate.resolved.source,
      expected: candidate.expected,
      envVar: candidate.envVar,
      preferenceKey: candidate.preferenceKey,
    }));
}

interface ResolvedValue {
  readonly value: unknown;
  readonly source: AgentOptionSource;
}

function resolveValue(
  flag: unknown,
  environment: unknown,
  profile: unknown,
  fallback: unknown,
): ResolvedValue {
  if (flag !== undefined) return { value: flag, source: 'flag' };
  return resolveStoredValue(environment, profile, fallback);
}

/**
 * Resolves a setting that has no per-run flag layer: environment, then
 * `profile.yaml`, then the pinned default.
 */
function resolveStoredValue(
  environment: unknown,
  profile: unknown,
  fallback: unknown,
): ResolvedValue {
  if (environment !== undefined) return { value: environment, source: 'env' };
  if (profile !== undefined && profile !== null) return { value: profile, source: 'profile' };
  return { value: fallback, source: 'default' };
}

function preference(prefs: EffectivePreferences, key: string): unknown {
  return prefs.get(key)?.value;
}

function scalarText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return value === null || value === undefined ? '' : '[invalid]';
}
