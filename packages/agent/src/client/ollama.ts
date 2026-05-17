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

export interface OllamaLLMClientOptions {
  readonly baseUrl: string;
  readonly model: string;
  readonly budget: LLMBudget;
}

/**
 * OllamaLLMClient — wraps pi-agent-core's Ollama provider (or direct fetch fallback).
 *
 * This implementation is a scaffold. When pi-agent-core is installed:
 *   1. Import `getModel` from 'pi-agent-core'.
 *   2. If pi-agent-core exposes Ollama: use `getModel("ollama", model, { baseUrl })`.
 *   3. If not: use a direct `fetch` against `${baseUrl}/api/chat` as documented in
 *      FEAT-011 TASK-004 ("fallback to direct fetch" note).
 *
 * Recommended models: llama3.1:8b (baseline), qwen2.5:7b, mistral-nemo:12b.
 *
 * @see pi-adapter.ts — the only file that imports pi-agent-core's tool types.
 * @see FEAT-011 TASK-004 for the full implementation spec.
 */
export class OllamaLLMClient implements LLMClient {
  public readonly providerId: string;

  public constructor(private readonly opts: OllamaLLMClientOptions) {
    const host = new URL(opts.baseUrl).host;
    this.providerId = `ollama:${opts.model}@${host}`;
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
    reason: 'ollama_unreachable',
    hint:
      'pi-agent-core is not installed. Install it with `pnpm add pi-agent-core` in packages/agent, ' +
      'then implement OllamaLLMClient.rawCall() per FEAT-011 TASK-004. ' +
      'Run `yantra doctor` to check Ollama connectivity.',
  };
}
