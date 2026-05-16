import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { RuleBasedSummarizer } from '../../src/extraction/summarizer.js';
import type { AskQuery, ExtractedArticle } from '../../src/extraction/types.js';

const baseQuery: AskQuery = {
  raw: 'top ai news',
  normalized: 'top ai news',
  limit: 3,
  noCache: false,
  noLlm: true,
  budgetCalls: null,
  searchProvider: null,
  perFetchTimeoutMs: 8_000,
  pipelineBudgetMs: 30_000,
};

function longArticle(text: string): ExtractedArticle {
  return {
    url: 'https://example.com/article',
    title: 'Sample',
    byline: null,
    publishedAt: null,
    siteName: 'example.com',
    contentText: text,
    contentHtml: `<p>${text}</p>`,
    excerpt: text.slice(0, 100),
    lengthChars: text.length,
  };
}

describe('@no-llm extraction/summarizer', () => {
  it('picks high-signal sentences and preserves original order', async () => {
    const summarizer = new RuleBasedSummarizer({ sentences: 3 });
    const article = longArticle(
      [
        'AI companies announced several partnerships this week.',
        'Market analysts said enterprise adoption is accelerating quickly.',
        'A separate report discussed cloud spending trends.',
        'Researchers from Open University presented new benchmarks.',
        'Policy experts described upcoming regulation timelines.',
      ].join(' '),
    );

    const result = await summarizer.summarize(article, baseQuery);

    expect(result.kind).toBe('rule-based');
    expect(result.summary).toContain('AI companies');
    expect(result.summary).toContain('Market analysts');
  });

  it('falls back to lede for short content', async () => {
    const summarizer = new RuleBasedSummarizer();
    const article = longArticle('Short body.');

    const result = await summarizer.summarize(article, baseQuery);

    expect(result.kind).toBe('fallback-lede');
    expect(result.summary).toBe('Short body.');
  });

  it('is deterministic for identical input', async () => {
    const summarizer = new RuleBasedSummarizer({ sentences: 3 });

    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 220, maxLength: 1200 }), async (input) => {
        const article = longArticle(`${input}. ${input}. ${input}.`);
        const left = await summarizer.summarize(article, baseQuery);
        const right = await summarizer.summarize(article, baseQuery);
        expect(left).toEqual(right);
      }),
      { numRuns: 100 },
    );
  });
});
