import { it } from 'vitest';

export * from './brief.js';

/**
 * Returns the current LLM provider as configured via the `LLM_PROVIDER`
 * environment variable. Falls back to `'none'` when unset so the deterministic
 * `--no-llm` code path is always the default in tests.
 */
export const llmProvider = (): string => {
  const provider = process.env.LLM_PROVIDER?.trim();
  return provider === '' ? 'none' : (provider ?? 'none');
};

/**
 * `true` when an LLM provider is configured (`anthropic`, `ollama`, ...).
 * `false` only when `LLM_PROVIDER` is `'none'` or unset.
 */
export const hasLlm = (): boolean => llmProvider() !== 'none';

/**
 * Vitest `it` variant that skips the test when no LLM provider is configured.
 *
 * Use for tests that exercise the LLM path; plain `it(...)` for tests that
 * must pass in every provider mode (mark them with a `@no-llm` describe
 * comment for documentation).
 */
export const itRequiresLlm: typeof it = it.skipIf(!hasLlm()) as typeof it;
