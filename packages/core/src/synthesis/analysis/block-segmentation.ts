/**
 * Block-aware analyzer decorator for Readability-shaped article text.
 *
 * Readability preserves headings and blank-line runs. winkNLP sentence
 * boundary detection is punctuation-driven, so an unpunctuated heading followed
 * by prose can become one "sentence" and slip into rendered bullets. This
 * decorator keeps analyzer implementations behavior-stable by splitting the
 * document into deterministic blocks first, analyzing each block independently,
 * then stitching the analyses back into one global analysis.
 *
 * Limitation: an SEO title glued directly to the first sentence with no newline
 * between them is not deterministically separable. The decorator only treats
 * blank lines and heading-shaped lines as hard boundaries.
 */

import type { AnalyzedSentence, DocAnalysis, TextAnalyzer, TypedEntity } from './text-analyzer.js';

const TERMINAL_PUNCTUATION = /[.!?:;]["')\]]?$/u;

/**
 * Splits source text into deterministic analysis blocks.
 *
 * @param text - Extracted article text.
 * @returns Non-empty blocks in reading order.
 */
export function splitIntoBlocks(text: string): string[] {
  const normalized = text.replace(/\r\n?/gu, '\n');
  const hardBlocks = normalized
    .split(/\n[ \t]*\n+/u)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);

  const blocks: string[] = [];
  for (const block of hardBlocks) {
    let current: string[] = [];
    for (const rawLine of block.split('\n')) {
      const line = rawLine.trim();
      if (line.length === 0) {
        continue;
      }
      if (isHeadingLine(line)) {
        if (current.length > 0) {
          blocks.push(current.join(' '));
          current = [];
        }
        blocks.push(line);
      } else {
        current.push(line);
      }
    }
    if (current.length > 0) {
      blocks.push(current.join(' '));
    }
  }

  return blocks;
}

/**
 * Analyzer decorator that applies block-aware segmentation before delegating.
 */
export class BlockSegmentingAnalyzer implements TextAnalyzer {
  private readonly cache = new Map<string, DocAnalysis>();

  /**
   * @param inner - Analyzer used for each block.
   */
  public constructor(private readonly inner: TextAnalyzer) {}

  /**
   * Analyzes a full document by splitting it into blocks, delegating each block
   * to the wrapped analyzer, and re-indexing sentences/entities globally.
   *
   * @param text - Full document text.
   * @returns Stitched analysis with contiguous sentence indexes.
   */
  public analyze(text: string): DocAnalysis {
    const cached = this.cache.get(text);
    if (cached !== undefined) {
      return cached;
    }

    const sentences: AnalyzedSentence[] = [];
    const entities: TypedEntity[] = [];
    const finiteVerbBySentence: boolean[] = [];

    for (const block of splitIntoBlocks(text)) {
      const analysis = this.inner.analyze(block);
      const offset = sentences.length;
      for (const sentence of analysis.sentences) {
        const index = offset + sentence.index;
        sentences.push({ ...sentence, index });
        finiteVerbBySentence[index] = analysis.hasFiniteVerb(sentence.index);
      }
      for (const entity of analysis.entities) {
        entities.push({ ...entity, sentenceIndex: offset + entity.sentenceIndex });
      }
    }

    const stitched: DocAnalysis = {
      sentences,
      entities,
      hasFiniteVerb: (sentenceIndex: number): boolean =>
        finiteVerbBySentence[sentenceIndex] ?? false,
    };
    this.cache.set(text, stitched);
    return stitched;
  }

  /**
   * Delegates text similarity to the wrapped analyzer.
   *
   * @param textA - First text.
   * @param textB - Second text.
   * @returns Similarity score in [0, 1].
   */
  public similarity(textA: string, textB: string): number {
    return this.inner.similarity(textA, textB);
  }

  /**
   * Delegates text containment to the wrapped analyzer.
   *
   * @param textA - First text.
   * @param textB - Second text.
   * @returns Containment coefficient in [0, 1].
   */
  public containment(textA: string, textB: string): number {
    return this.inner.containment(textA, textB);
  }
}

function isHeadingLine(line: string): boolean {
  if (line.length > 80 || TERMINAL_PUNCTUATION.test(line)) {
    return false;
  }
  const words = line.split(/\s+/u).filter(Boolean);
  if (words.length === 0 || words.length > 12) {
    return false;
  }
  const titleLike = words.filter((word) => /^[\p{Lu}\d]/u.test(word)).length;
  return titleLike / words.length >= 0.5;
}
