import { describe, expect, it } from 'vitest';

import { BaselineAnalyzer } from '../../../src/synthesis/analysis/baseline-analyzer.js';
import { WinkAnalyzer } from '../../../src/synthesis/analysis/wink-analyzer.js';
import { selectMmr, textRank } from '../../../src/synthesis/evidence/rank.js';

const overlap = (left: string, right: string): number => {
  const a = new Set(left.split(' '));
  const b = new Set(right.split(' '));
  return [...a].filter((word) => b.has(word)).length / Math.max(a.size, b.size);
};

describe('@no-llm evidence ranking', () => {
  it('produces deterministic TextRank scores with order-stable ties', () => {
    const texts = ['alpha beta', 'alpha gamma', 'delta epsilon'];
    expect(textRank(texts, overlap)).toEqual(textRank(texts, overlap));
    expect(textRank(['a', 'b'], () => 0)).toEqual([0.07500000000000001, 0.07500000000000001]);
  });

  it('selects the most relevant item first and penalizes a redundant second item', () => {
    const items = [
      { text: 'world cup norway semifinal', relevance: 1 },
      { text: 'world cup norway semifinal rematch', relevance: 0.95 },
      { text: 'host cities expand transit', relevance: 0.8 },
    ];
    const selected = selectMmr(
      items,
      (item) => item.relevance,
      (a, b) => overlap(a.text, b.text),
      0.7,
      2,
    );
    expect(selected[0]).toBe(items[0]);
    expect(selected[1]).toBe(items[2]);
  });

  it('keeps containment behavior in parity across analyzer implementations', () => {
    const left = 'Norway stand one win from an unprecedented World Cup semi-final.';
    const right = `${left.slice(0, -1)} after defeating England in Oslo.`;
    const baseline = new BaselineAnalyzer().containment(left, right);
    const wink = new WinkAnalyzer().containment(left, right);
    expect(Math.abs(baseline - wink)).toBeLessThan(0.2);
  });
});
