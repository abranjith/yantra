import { err } from '@yantra/protocol';
import type { Result } from '@yantra/protocol';

import type {
  GeneratePlanOpts,
  GeneratePlanResult,
  LLMClient,
  LLMError,
  SummarizeOpts,
  SummarizeResult,
} from './interface.js';

const UNAVAILABLE: LLMError = {
  kind: 'llm_unavailable',
  reason: 'provider_none',
  hint: 'Configure LLM_PROVIDER=anthropic or =ollama; see `yantra doctor`.',
};

/**
 * No-op LLMClient returned when LLM_PROVIDER=none or no provider is configured.
 *
 * Every method returns LLMUnavailable immediately — no I/O, no allocation.
 * The audit wrapper still wraps this client so intent-to-call is logged even
 * in --no-llm mode.
 */
export class NullLLMClient implements LLMClient {
  public readonly providerId = 'null';

  public generatePlan(_opts: GeneratePlanOpts): Promise<Result<GeneratePlanResult, LLMError>> {
    return Promise.resolve(err(UNAVAILABLE));
  }

  public summarize(_opts: SummarizeOpts): Promise<Result<SummarizeResult, LLMError>> {
    return Promise.resolve(err(UNAVAILABLE));
  }
}
