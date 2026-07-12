import { describe, expect, it } from 'vitest';

import { WinkAnalyzer } from '../../../src/synthesis/analysis/wink-analyzer.js';
import { extractEligibleClaims } from '../../../src/synthesis/evidence/eligibility.js';
import { buildQueryProfile } from '../../../src/synthesis/evidence/query-profile.js';
import type { SynthesisDoc } from '../../../src/synthesis/types.js';

const analyzer = new WinkAnalyzer();
const profile = buildQueryProfile('State of EV car sales in US in 2026', analyzer);

function doc(text: string, url = 'https://ev.example.com/a'): SynthesisDoc {
  return {
    url,
    finalUrl: null,
    host: new URL(url).hostname,
    title: null,
    fetchedAt: '2026-06-01T00:00:00.000Z',
    publishedAt: null,
    text,
    excerpt: null,
  };
}

const claimTexts = (docs: readonly SynthesisDoc[]): string[] =>
  extractEligibleClaims(docs, profile, analyzer).map((claim) => claim.text);

describe('@no-llm synthesis/extractEligibleClaims hard gates', () => {
  it('accepts an on-topic, grammatical figure sentence', () => {
    const texts = claimTexts([
      doc('Electric vehicle sales declined 28% across the US in 2026 amid tighter supply.'),
    ]);
    expect(texts.some((text) => text.includes('28%'))).toBe(true);
  });

  it('rejects a heading with no finite verb', () => {
    const texts = claimTexts([
      doc(
        'State-Wise EV Sales & Adoption in the U.S. Electric vehicle sales declined 28% across the US in 2026 nationwide.',
      ),
    ]);
    expect(texts).not.toContain('State-Wise EV Sales & Adoption in the U.S.');
  });

  it('rejects a listicle heading fragment', () => {
    const texts = claimTexts([
      doc(
        '125 Interesting Facts About Electric Cars Electric vehicle sales declined 28% across the US in 2026 nationwide.',
      ),
    ]);
    expect(texts).not.toContain('125 Interesting Facts About Electric Cars');
  });

  it('rejects an off-topic grammatical sentence with no query terms', () => {
    const texts = claimTexts([
      doc(
        'Electric vehicle sales declined 28% across the US in 2026 nationwide. NASA scientists confirmed that ancient water once flowed across the surface of Mars.',
      ),
    ]);
    expect(texts.some((text) => text.includes('Mars'))).toBe(false);
    expect(texts.some((text) => text.includes('28%'))).toBe(true);
  });

  it('rejects an off-topic number whose kind the query does not want and that names no target entity', () => {
    // A price ($) figure for a rate/trend query, in a sentence with no EV/US terms.
    const texts = claimTexts([
      doc(
        'Electric vehicle sales declined 28% across the US in 2026 nationwide. The downtown bakery sold pastries for $12 a box last weekend to eager customers.',
      ),
    ]);
    expect(texts.some((text) => text.includes('$12'))).toBe(false);
  });
});

describe('@no-llm synthesis/extractEligibleClaims sentence-level support', () => {
  const claimText =
    'Electric vehicle sales declined 28% across the US in 2026 amid tighter supply.';

  it('counts only documents whose sentences actually restate the claim', () => {
    const docs = [
      doc(`${claimText} Analysts reviewed the quarterly figures.`, 'https://a.example.com/1'),
      // Restates the claim (same figure + heavy lemma overlap).
      doc(`${claimText} Coverage of the decline continued all week.`, 'https://b.example.com/1'),
      // On-topic EV doc, but NO sentence restates the 28% decline claim.
      doc(
        'Battery costs for electric vehicles keep improving as manufacturers scale production in the US.',
        'https://c.example.com/1',
      ),
    ];

    const claims = extractEligibleClaims(docs, profile, analyzer);
    const claim = claims.find((entry) => entry.text === claimText);
    expect(claim).toBeDefined();
    // Supported by docs 0 and 1 (which restate it), not doc 2.
    expect(claim!.docIndexes).toEqual([0, 1]);
  });

  it('always carries at least the origin document as evidence', () => {
    const claims = extractEligibleClaims(
      [doc('Electric vehicle sales declined 28% across the US in 2026 amid tighter supply.')],
      profile,
      analyzer,
    );
    for (const claim of claims) {
      expect(claim.docIndexes.length).toBeGreaterThanOrEqual(1);
      expect(claim.docIndexes[0]).toBe(0);
    }
  });
});

describe('@no-llm synthesis/extractEligibleClaims ranking + metadata', () => {
  const docs = [
    doc('Electric vehicle sales declined 28% across the US in 2026 amid tighter supply.'),
    doc(
      'US EV adoption slowed as car buyers hesitated over pricing throughout the 2026 sales season.',
      'https://d.example.com/1',
    ),
  ];

  it('tags each claim with its evidence kinds', () => {
    const claims = extractEligibleClaims(docs, profile, analyzer);
    const percentClaim = claims.find((claim) => claim.text.includes('28%'));
    expect(percentClaim).toBeDefined();
    expect(percentClaim!.evidenceKinds).toContain('percent');
  });

  it('is deterministic: identical input yields an identical ranking', () => {
    expect(extractEligibleClaims(docs, profile, analyzer)).toEqual(
      extractEligibleClaims(docs, profile, analyzer),
    );
  });

  it('returns an empty list for an empty doc set', () => {
    expect(extractEligibleClaims([], profile, analyzer)).toEqual([]);
  });
});
