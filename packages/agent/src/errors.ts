/**
 * Custom error classes derived from LLMError discriminated union variants.
 * Thrown by internal code; public API surfaces return Result<T, LLMError>.
 */

export class LLMUnavailableError extends Error {
  public readonly kind = 'llm_unavailable' as const;

  public constructor(
    public readonly reason: 'provider_none' | 'missing_api_key' | 'ollama_unreachable',
    public readonly hint: string,
  ) {
    super(`LLM unavailable (${reason}): ${hint}`);
    this.name = 'LLMUnavailableError';
  }
}

export class LLMTimeoutError extends Error {
  public readonly kind = 'llm_timeout' as const;

  public constructor(
    public readonly elapsedMs: number,
    public readonly budgetMs: number,
  ) {
    super(`LLM call timed out after ${elapsedMs}ms (budget: ${budgetMs}ms)`);
    this.name = 'LLMTimeoutError';
  }
}

export class LLMProviderError extends Error {
  public readonly kind = 'llm_provider_error' as const;

  public constructor(
    public readonly providerCode: string | null,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'LLMProviderError';
  }
}

export class LLMValidationFailedError extends Error {
  public readonly kind = 'llm_validation_failed' as const;

  public constructor(
    public readonly attempts: number,
    public readonly errors: readonly { path: string; code: string; message: string }[],
    public readonly userFacingHint: string,
  ) {
    super(`LLM plan validation failed after ${attempts} attempt(s): ${userFacingHint}`);
    this.name = 'LLMValidationFailedError';
  }
}

export class LLMBudgetExhaustedError extends Error {
  public readonly kind = 'llm_budget_exhausted' as const;

  public constructor(
    public readonly callsMade: number,
    public readonly maxCalls: number,
  ) {
    super(`LLM budget exhausted: ${callsMade} of ${maxCalls} calls used`);
    this.name = 'LLMBudgetExhaustedError';
  }
}

export class SanitizerGuardError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'SanitizerGuardError';
  }
}
