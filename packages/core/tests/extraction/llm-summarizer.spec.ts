import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLlmSummarizer } from '../../src/extraction/llm-summarizer.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('@no-llm extraction/llm-summarizer', () => {
  it('returns null when llmClient is null', () => {
    const summarizer = createLlmSummarizer({
      llmClient: null,
      sanitizer: { sanitize: () => ({ text: '', transformations: [] }) },
      featureGate: { llmSummarize: true },
    });

    expect(summarizer).toBeNull();
  });

  it('returns null when LLM_PROVIDER=none', () => {
    vi.stubEnv('LLM_PROVIDER', 'none');

    const summarizer = createLlmSummarizer({
      llmClient: { summarize: async () => ({ text: 'x' }) },
      sanitizer: { sanitize: () => ({ text: '', transformations: [] }) },
      featureGate: { llmSummarize: true },
    });

    expect(summarizer).toBeNull();
  });

  it('returns null when noLlm flag is true', () => {
    const summarizer = createLlmSummarizer({
      llmClient: { summarize: async () => ({ text: 'x' }) },
      sanitizer: { sanitize: () => ({ text: '', transformations: [] }) },
      featureGate: { llmSummarize: true },
      noLlm: true,
    });

    expect(summarizer).toBeNull();
  });

  it.skip('synthesizes via LLM when lit up - FEAT-011', async () => {
    // FEAT-011: enable real LLM summarization behavior.
  });
});
