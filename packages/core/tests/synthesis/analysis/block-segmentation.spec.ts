import { describe, expect, it } from 'vitest';

import { BaselineAnalyzer } from '../../../src/synthesis/analysis/baseline-analyzer.js';
import {
  BlockSegmentingAnalyzer,
  splitIntoBlocks,
} from '../../../src/synthesis/analysis/block-segmentation.js';
import { WinkAnalyzer } from '../../../src/synthesis/analysis/wink-analyzer.js';

describe('@no-llm synthesis/splitIntoBlocks', () => {
  it('splits blank-line runs and unpunctuated heading lines', () => {
    expect(splitIntoBlocks('State of EV Sales\n\n\nSales fell 28% in 2026.')).toEqual([
      'State of EV Sales',
      'Sales fell 28% in 2026.',
    ]);
    expect(splitIntoBlocks('State of EV Sales\nSales fell 28% in 2026.')).toEqual([
      'State of EV Sales',
      'Sales fell 28% in 2026.',
    ]);
  });

  it('keeps hard-wrapped prose joined and normalizes CRLF input', () => {
    expect(splitIntoBlocks('Sales fell sharply across\r\nthe US market in 2026.')).toEqual([
      'Sales fell sharply across the US market in 2026.',
    ]);
  });

  it('returns no blocks for empty or whitespace-only text', () => {
    expect(splitIntoBlocks(' \n\t\r\n ')).toEqual([]);
  });
});

describe('@no-llm synthesis/BlockSegmentingAnalyzer', () => {
  it('stitches baseline analyses with contiguous sentence and entity indexes', () => {
    const analyzer = new BlockSegmentingAnalyzer(new BaselineAnalyzer());
    const analysis = analyzer.analyze(
      'EV Sales\nSales fell 28% in 2026.\n\nPrices fell to $39,000.',
    );

    expect(analysis.sentences.map((sentence) => sentence.index)).toEqual([0, 1, 2]);
    expect(analysis.entities.map((entity) => entity.sentenceIndex)).toEqual([1, 1, 2]);
    expect(analysis.hasFiniteVerb(0)).toBe(false);
    expect(analysis.hasFiniteVerb(1)).toBe(true);
  });

  it('re-indexes negation, sentiment, and junk score with the stitched sentences', () => {
    const inner = new WinkAnalyzer();
    const analyzer = new BlockSegmentingAnalyzer(inner);
    const analysis = analyzer.analyze(
      'Home News Sport Business Innovation Culture Arts Travel.\n\nSales did not rise in 2024.',
    );

    const negatedIndex = analysis.sentences.findIndex((sentence) => sentence.negated);
    expect(negatedIndex).toBeGreaterThan(-1);
    expect(analysis.sentences[negatedIndex]!.text).toContain('did not rise');

    const junkIndex = analysis.sentences.findIndex((sentence) => sentence.text.startsWith('Home'));
    expect(analysis.junkScore(junkIndex)).toBeGreaterThan(analysis.junkScore(negatedIndex));
    expect(analysis.junkScore(99)).toBe(0);
  });

  it('memoizes full-document analyses and delegates similarity', () => {
    const inner = new WinkAnalyzer();
    const analyzer = new BlockSegmentingAnalyzer(inner);
    const text = 'EV Sales\nSales rose 10% in 2026.';

    expect(analyzer.analyze(text)).toBe(analyzer.analyze(text));
    expect(analyzer.similarity('EV sales rose', 'EV sales increased')).toBe(
      inner.similarity('EV sales rose', 'EV sales increased'),
    );
  });
});
