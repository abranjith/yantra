/**
 * Best-effort per-token cost estimates for known models.
 *
 * These are advisory estimates — they drift as providers change pricing.
 * The `cost_estimate_usd` field in agent.jsonl is labelled "estimate" in
 * all user-facing output. Null is always valid; Ollama local models return null.
 *
 * Sources: Anthropic pricing page, updated 2026-05.
 * Prices in USD per million tokens.
 */
interface TokenPricing {
  readonly inputPerMillion: number;
  readonly outputPerMillion: number;
}

const PRICING_TABLE: Record<string, TokenPricing> = {
  // Claude 4 family
  'claude-opus-4-7': { inputPerMillion: 15.0, outputPerMillion: 75.0 },
  'claude-opus-4-6': { inputPerMillion: 15.0, outputPerMillion: 75.0 },
  'claude-sonnet-4-6': { inputPerMillion: 3.0, outputPerMillion: 15.0 },
  'claude-haiku-4-5-20251001': { inputPerMillion: 0.8, outputPerMillion: 4.0 },
  // Claude 3.5 family (legacy)
  'claude-3-5-sonnet-20241022': { inputPerMillion: 3.0, outputPerMillion: 15.0 },
  'claude-3-5-haiku-20241022': { inputPerMillion: 0.8, outputPerMillion: 4.0 },
  'claude-3-opus-20240229': { inputPerMillion: 15.0, outputPerMillion: 75.0 },
};

/**
 * Estimates cost in USD for a single LLM call.
 * Returns null for unknown models or local providers (Ollama).
 */
export function estimateCostUsd(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
): number | null {
  // Match by prefix (model IDs often include date suffixes)
  const key = Object.keys(PRICING_TABLE).find((k) => modelId === k || modelId.startsWith(k));

  if (!key) {
    return null;
  }

  const pricing = PRICING_TABLE[key];
  if (!pricing) {
    return null;
  }

  const inputCost = (inputTokens / 1_000_000) * pricing.inputPerMillion;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPerMillion;
  return inputCost + outputCost;
}
