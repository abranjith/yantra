import { err } from '@yantra/protocol';
import type { Result } from '@yantra/protocol';

import type {
  GeneratePlanOpts,
  GeneratePlanResult,
  LLMBudget,
  LLMClient,
  LLMError,
  SummarizeOpts,
  SummarizeResult,
} from './interface.js';

export interface AnthropicLLMClientOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly budget: LLMBudget;
}

/**
 * AnthropicLLMClient — wraps pi-agent-core's Anthropic provider.
 *
 * This implementation is a scaffold. When pi-agent-core is installed:
 *   1. Import `getModel` from 'pi-agent-core'.
 *   2. Replace rawCall with a real Agent construction + prompt call.
 *   3. Wire event hooks to the audit sink for per-call telemetry.
 *
 * @see pi-adapter.ts — the only file that imports pi-agent-core's tool types.
 * @see FEAT-011 TASK-003 for the full implementation spec.
 */
export class AnthropicLLMClient implements LLMClient {
  public readonly providerId: string;

  public constructor(private readonly opts: AnthropicLLMClientOptions) {
    this.providerId = `anthropic:${opts.model}`;
  }

  public generatePlan(_opts: GeneratePlanOpts): Promise<Result<GeneratePlanResult, LLMError>> {
    return Promise.resolve(err(piAgentCoreUnavailable()));
  }

  public summarize(_opts: SummarizeOpts): Promise<Result<SummarizeResult, LLMError>> {
    return Promise.resolve(err(piAgentCoreUnavailable()));
  }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function piAgentCoreUnavailable(): LLMError {
  return {
    kind: 'llm_unavailable',
    reason: 'missing_api_key',
    hint:
      'pi-agent-core is not installed. Install it with `pnpm add pi-agent-core` in packages/agent, ' +
      'then implement AnthropicLLMClient.rawCall() per FEAT-011 TASK-003.',
  };
}
