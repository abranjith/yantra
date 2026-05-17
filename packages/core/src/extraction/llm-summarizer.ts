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
 * Returns an LLM-backed summarizer when all gates are enabled, or null to fall
 * through to the rule-based path.
 */
export function createLlmSummarizer(options: LlmSummarizerFactoryOptions): LlmSummarizer | null {
  if (options.llmClient === null) {
    return null;
  }

  if (process.env.LLM_PROVIDER === 'none') {
    return null;
  }

  if (options.noLlm === true) {
    return null;
  }

  if (options.featureGate.llmSummarize !== true) {
    return null;
  }

  return new LlmBackedSummarizer(options.llmClient, options.sanitizer);
}

class LlmBackedSummarizer implements LlmSummarizer {
  public constructor(
    private readonly llmClient: LlmClient,
    private readonly sanitizer: Sanitizer,
  ) {}

  public async summarize(
    article: ExtractedArticle,
    query: AskQuery,
  ): Promise<{ summary: string; kind: AskCard['summaryKind'] }> {
    const sanitized = this.sanitizer.sanitize(article.contentText, 'public');
    const prompt = `Summarize the following content concisely, focusing on the query: "${query.raw}". Be factual and do not invent information.`;

    try {
      const result = await this.llmClient.summarize(sanitized.text, prompt);
      return { summary: result.text.trim(), kind: 'llm-enhanced' };
    } catch {
      // Fall through to fallback if LLM call fails
      return {
        summary: article.excerpt?.slice(0, 280) ?? article.contentText.slice(0, 280),
        kind: 'fallback-lede',
      };
    }
  }
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
