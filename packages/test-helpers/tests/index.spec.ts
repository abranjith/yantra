import { afterEach, describe, expect, it, vi } from 'vitest';

import { hasLlm, llmProvider } from '../src/index.js';

describe('@no-llm test-helpers / llmProvider', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns the LLM_PROVIDER env value when set', () => {
    vi.stubEnv('LLM_PROVIDER', 'anthropic');
    expect(llmProvider()).toBe('anthropic');
  });

  it('defaults to "none" when LLM_PROVIDER is unset', () => {
    vi.stubEnv('LLM_PROVIDER', '');
    expect(llmProvider()).toBe('none');
  });

  it('treats "none" as no LLM available', () => {
    vi.stubEnv('LLM_PROVIDER', 'none');
    expect(hasLlm()).toBe(false);
  });

  it('treats "anthropic" as LLM available', () => {
    vi.stubEnv('LLM_PROVIDER', 'anthropic');
    expect(hasLlm()).toBe(true);
  });

  it('treats "ollama" as LLM available', () => {
    vi.stubEnv('LLM_PROVIDER', 'ollama');
    expect(hasLlm()).toBe(true);
  });
});
