/**
 * Offline agent configuration diagnostics. These checks answer what model,
 * credential source, and budgets Yantra will use without opening a provider
 * session or exposing credential material.
 */

import type { EffectivePreferences, KeychainProvider } from '@yantra/core';

import { probePiCredential, type PiCredentialProbe } from '../adapters/pi/environment.js';
import type { AgentAuthSelection } from '../provider/types.js';

import { DEFAULT_AGENT_BUDGETS } from './orchestrator.js';

/** Pinned provider shared by CLI resolution and diagnostics. */
export const DEFAULT_AGENT_PROVIDER = 'anthropic';

/** Pinned model shared by CLI resolution and diagnostics. */
export const DEFAULT_AGENT_MODEL = 'claude-haiku-4-5';

/** Which layer supplied an effective diagnostic value. */
export type AgentOptionSource = 'flag' | 'env' | 'profile' | 'default';

/** Raw shared option values accepted by offline diagnostics. */
export interface AgentDiagnosticOptions {
  readonly provider?: string;
  readonly model?: string;
  readonly thinking?: string;
  readonly authSecret?: string;
  readonly maxDuration?: string;
  readonly maxTokens?: string;
  readonly toolTimeout?: string;
  readonly toolRetries?: string;
  readonly confirmTimeout?: string;
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
 * doctor`. Resolution is flag > environment > profile > pinned default.
 */
export async function runAgentDiagnostics(
  env: NodeJS.ProcessEnv,
  prefs: EffectivePreferences,
  options: AgentDiagnosticOptions = {},
  dependencies: AgentDiagnosticDependencies = {},
): Promise<readonly AgentDoctorCheck[]> {
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

  const duration = resolveValue(
    options.maxDuration,
    env.YANTRA_AGENT_MAX_DURATION,
    preference(prefs, 'agent.max_duration'),
    compactDuration(DEFAULT_AGENT_BUDGETS.wallClockMs),
  );
  const tokens = resolveValue(
    options.maxTokens,
    env.YANTRA_AGENT_MAX_TOKENS,
    preference(prefs, 'agent.max_tokens'),
    DEFAULT_AGENT_BUDGETS.maxProviderTokens,
  );
  const toolTimeout = resolveValue(
    options.toolTimeout,
    env.YANTRA_AGENT_TOOL_TIMEOUT,
    preference(prefs, 'agent.tool_timeout'),
    compactDuration(DEFAULT_AGENT_BUDGETS.perToolTimeoutMs),
  );
  const retries = resolveValue(
    options.toolRetries,
    env.YANTRA_AGENT_TOOL_RETRIES,
    preference(prefs, 'agent.tool_retries'),
    DEFAULT_AGENT_BUDGETS.toolRetries,
  );
  const confirmTimeout = resolveValue(
    options.confirmTimeout,
    env.YANTRA_AGENT_CONFIRM_TIMEOUT,
    preference(prefs, 'agent.confirm_timeout'),
    compactDuration(DEFAULT_AGENT_BUDGETS.confirmationWaitMs),
  );

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
      status: 'ok',
      message:
        `Agent budgets: duration=${scalarText(duration.value)}(${duration.source}), ` +
        `tokens=${scalarText(tokens.value)}(${tokens.source}), ` +
        `tool-timeout=${scalarText(toolTimeout.value)}(${toolTimeout.source}), ` +
        `retries=${scalarText(retries.value)}(${retries.source}), ` +
        `confirm-timeout=${scalarText(confirmTimeout.value)}(${confirmTimeout.source}).`,
      details: { duration, tokens, toolTimeout, retries, confirmTimeout },
      fixHint: null,
    },
  ];
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
  if (environment !== undefined) return { value: environment, source: 'env' };
  if (profile !== undefined && profile !== null) return { value: profile, source: 'profile' };
  return { value: fallback, source: 'default' };
}

function preference(prefs: EffectivePreferences, key: string): unknown {
  return prefs.get(key)?.value;
}

function compactDuration(milliseconds: number): string {
  if (milliseconds % 3_600_000 === 0) return `${milliseconds / 3_600_000}h`;
  if (milliseconds % 60_000 === 0) return `${milliseconds / 60_000}m`;
  if (milliseconds % 1_000 === 0) return `${milliseconds / 1_000}s`;
  return `${milliseconds}ms`;
}

function scalarText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return value === null || value === undefined ? '' : '[invalid]';
}
