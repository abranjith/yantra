import type { LLMBudget } from './interface.js';
import type { LLMClient } from './interface.js';
import { NullLLMClient } from './null.js';

// ---------------------------------------------------------------------------
// Provider configuration
// ---------------------------------------------------------------------------

export type ProviderName = 'anthropic' | 'ollama' | 'openai' | 'none';

export interface ProviderConfig {
  readonly provider: ProviderName;
  readonly anthropic?: {
    readonly apiKey:
      | { kind: 'env'; name: 'ANTHROPIC_API_KEY' }
      | { kind: 'keychain'; service: 'yantra'; account: 'anthropic.api_key' };
    readonly model: string;
  };
  readonly ollama?: {
    readonly baseUrl: string;
    readonly model: string;
  };
  /** Phase 2 — scaffold only. */
  readonly openai?: { readonly apiKey: unknown; readonly model: string };
  readonly defaultBudget: LLMBudget;
}

export interface LLMClientDeps {
  readonly auditWriter?: {
    appendAgentCall(entry: unknown): Promise<void>;
  };
  readonly usageWriter?: {
    append(call: unknown): Promise<void>;
  };
  readonly keychainProvider?: {
    get(service: string, account: string): Promise<string | null>;
  };
  readonly logger?: {
    warn(obj: object | string, msg?: string): void;
    info(obj: object | string, msg?: string): void;
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates the appropriate LLMClient based on provider configuration.
 *
 * Resolution order: LLM_PROVIDER env var > config.provider > 'none'.
 * Never throws — always returns a valid LLMClient (NullLLMClient on failure).
 */
export function createLLMClient(config: ProviderConfig, deps: LLMClientDeps = {}): LLMClient {
  const envProvider = process.env.LLM_PROVIDER as ProviderName | undefined;
  const provider = envProvider ?? config.provider;
  const logger = deps.logger;

  switch (provider) {
    case 'none':
      return new NullLLMClient();

    case 'anthropic': {
      const anthropicCfg = config.anthropic;
      if (!anthropicCfg) {
        logger?.warn(
          { provider: 'anthropic' },
          'anthropic configured but no anthropic config block; degrading to none',
        );
        return new NullLLMClient();
      }

      const apiKey = resolveAnthropicKey(anthropicCfg.apiKey, deps);
      if (!apiKey) {
        logger?.warn(
          { provider: 'anthropic' },
          'anthropic configured but no API key found; degrading to none',
        );
        return new NullLLMClient();
      }

      // AnthropicLLMClient requires pi-agent-core — return NullLLMClient when unavailable.
      // TODO: Replace with AnthropicLLMClient when pi-agent-core is installed.
      logger?.warn(
        { provider: 'anthropic' },
        'pi-agent-core not installed — AnthropicLLMClient unavailable; degrading to none',
      );
      return new NullLLMClient();
    }

    case 'ollama': {
      // OllamaLLMClient requires pi-agent-core — return NullLLMClient when unavailable.
      // TODO: Replace with OllamaLLMClient when pi-agent-core is installed.
      logger?.warn(
        { provider: 'ollama' },
        'pi-agent-core not installed — OllamaLLMClient unavailable; degrading to none',
      );
      return new NullLLMClient();
    }

    case 'openai': {
      logger?.warn({ provider: 'openai' }, 'openai not supported in MVP; degrading to none');
      return new NullLLMClient();
    }

    default: {
      logger?.warn({ provider: String(provider) }, 'Unknown LLM provider; degrading to none');
      return new NullLLMClient();
    }
  }
}

function resolveAnthropicKey(
  apiKeyConfig: NonNullable<ProviderConfig['anthropic']>['apiKey'],
  _deps: LLMClientDeps,
): string | null {
  if (apiKeyConfig.kind === 'env') {
    return process.env[apiKeyConfig.name] ?? null;
  }

  // keychain: synchronous resolution not possible here; factory is sync.
  // Callers that need keychain-backed keys must resolve via deps.keychainProvider
  // before calling createLLMClient, or use the async factory variant (Phase 2).
  // For MVP: fall back to env var as a heuristic.
  const envKey = process.env.ANTHROPIC_API_KEY;
  return envKey ?? null;
}
