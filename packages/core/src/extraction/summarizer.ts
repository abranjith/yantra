import type { AskCard, AskQuery, ExtractedArticle } from './types.js';

export interface Summarizer {
  summarize(
    article: ExtractedArticle,
    query: AskQuery,
  ): Promise<{ summary: string; kind: AskCard['summaryKind'] }>;
}

export interface RuleBasedSummarizerOptions {
  readonly sentences?: number;
  readonly queryTermBoost?: number;
  readonly positionDecay?: number;
}

/**
 * Deterministic sentence-ranking summarizer for the no-LLM ask path.
 */
export class RuleBasedSummarizer implements Summarizer {
  private readonly sentenceCount: number;
  private readonly queryTermBoost: number;
  private readonly positionDecay: number;

  public constructor(options: RuleBasedSummarizerOptions = {}) {
    this.sentenceCount = options.sentences ?? 3;
    this.queryTermBoost = options.queryTermBoost ?? 1.2;
    this.positionDecay = options.positionDecay ?? 0.25;
  }

  public summarize(
    article: ExtractedArticle,
    query: AskQuery,
  ): Promise<{ summary: string; kind: AskCard['summaryKind'] }> {
    const text = article.contentText.trim();
    if (text.length < 200) {
      return Promise.resolve({
        summary: fallbackLede(article),
        kind: 'fallback-lede',
      });
    }

    const sentences = splitSentences(text).slice(0, 8);
    if (sentences.length === 0) {
      return Promise.resolve({
        summary: fallbackLede(article),
        kind: 'fallback-lede',
      });
    }

    const queryTerms = tokenize(query.normalized);
    const scored = sentences.map((sentence, index) => {
      const lowerSentence = sentence.toLowerCase();
      const overlapCount = queryTerms.reduce(
        (acc, term) => (lowerSentence.includes(term) ? acc + 1 : acc),
        0,
      );
      const overlap = queryTerms.length === 0 ? 0 : overlapCount / queryTerms.length;
      const positionScore = 1 / (1 + index * this.positionDecay);
      const entityBonus = /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/.test(sentence) ? 0.2 : 0;
      return {
        sentence,
        index,
        score: positionScore + overlap * this.queryTermBoost + entityBonus,
      };
    });

    const picks = [...scored]
      .filter((entry) => entry.score > 0.1)
      .sort((left, right) => right.score - left.score || left.index - right.index)
      .slice(0, this.sentenceCount)
      .sort((left, right) => left.index - right.index);

    if (picks.length === 0) {
      return Promise.resolve({
        summary: fallbackLede(article),
        kind: 'fallback-lede',
      });
    }

    return Promise.resolve({
      summary: picks.map((entry) => entry.sentence).join(' ').trim(),
      kind: 'rule-based',
    });
  }
}

function splitSentences(text: string): string[] {
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
    return [...segmenter.segment(text)]
      .map((item) => item.segment.trim())
      .filter((segment) => segment.length > 0);
  }

  return text
    .split(/(?<=[.!?])\s+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function fallbackLede(article: ExtractedArticle): string {
  const excerpt = article.excerpt?.trim() ?? '';
  const source = excerpt.length > 0 ? excerpt : article.contentText.trim();
  return source.slice(0, 280);
}

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 1);
}
