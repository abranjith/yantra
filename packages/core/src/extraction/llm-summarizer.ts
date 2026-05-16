import type { Sanitizer } from '../sanitizer/index.js';

import type { Summarizer } from './summarizer.js';
import type { AskCard, AskQuery, ExtractedArticle } from './types.js';

export interface LlmClient {
  summarize(input: string, prompt: string): Promise<{ text: string }>;
}

export type LlmSummarizer = Summarizer;

export interface LlmSummarizerFactoryOptions {
  readonly llmClient: LlmClient | null;
  readonly sanitizer: Sanitizer;
  readonly featureGate: {
    readonly llmSummarize: boolean;
  };
  readonly noLlm?: boolean;
}

/**
 * Returns an LLM summarizer when all gates are enabled.
 *
 * In FEAT-007 this intentionally returns null even when enabled to keep
 * the ask pipeline agent-optional by default.
 */
export function createLlmSummarizer(_options: LlmSummarizerFactoryOptions): LlmSummarizer | null {
  if (_options.llmClient === null) {
    return null;
  }

  if (process.env.LLM_PROVIDER === 'none') {
    return null;
  }

  if (_options.noLlm === true) {
    return null;
  }

  if (_options.featureGate.llmSummarize !== true) {
    return null;
  }

  // FEAT-011: Implement LLM-backed summarization through the sanitizer chokepoint.
  return null;
}

export class DisabledLlmSummarizer implements LlmSummarizer {
  public summarize(
    article: ExtractedArticle,
    _query: AskQuery,
  ): Promise<{ summary: string; kind: AskCard['summaryKind'] }> {
    return Promise.resolve({
      summary: article.excerpt?.slice(0, 280) ?? article.contentText.slice(0, 280),
      kind: 'fallback-lede',
    });
  }
}
