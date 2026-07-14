import { describe, expect, it } from 'vitest';

import { WinkAnalyzer } from '../../../src/synthesis/analysis/wink-analyzer.js';
import {
  extractEligibleClaims,
  isJunkSentence,
} from '../../../src/synthesis/evidence/eligibility.js';
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

describe('@no-llm synthesis/isJunkSentence (gate 0.5)', () => {
  const junk: readonly string[] = [
    // Every string that leaked into the reference brief (run 842c64d1).
    'Match previewsMatch previewsSee allNOR1 FT2 ENGNOR1 FT2 ENGMatch PreviewMatch PreviewNorway break new ground as England aim to halt HaalandNorway stand one win from an unprecedented semi-final.',
    'WORLD CUP HEADLINESNextBEST OF SI FCThere were layers to the USMNT’s victory over Bosnia and Herzegovina.',
    'WATCH SI FCWhy France Are The Main Candidate To Win The World CupWelcome to the big leagues.',
    '01:18:30 | Jul 10, 2026MUST READS The 2018 World Cup champion scored in a friendly.',
    '† denotes a stadium used for previous men’s World Cup tournaments.',
    '1,000th FIFA World Cup match',
    'Lamine Yamal is still waiting for his World Cup moment - is he waiting until it really matters to turn on the style?',
    'MUST READS The 2018 World Cup champion scored in a friendly against the Rowdies.',
  ];

  const legitimate: readonly string[] = [
    'Norway stand one win from an unprecedented semi-final, while England aim to return to the FIFA World Cup last four in an intriguing all-European quarter-final in Miami.',
    'The 2026 FIFA World Cup is the 23rd FIFA World Cup and the current edition of the quadrennial international championship.',
    'On June 25, 2026, total attendance reached 3,605,357 spectators, setting the record for the highest attendance in World Cup history.',
    'There were layers to the USMNT’s victory over Bosnia and Herzegovina which exposed how deep Pochettino’s influence goes.',
    'McDonald’s promoted the tournament with an iPhone app built for supporters.',
    'Mexico became the first country to host or co-host the World Cup three times, having hosted the 1970 and 1986 tournaments.',
    '“Europe and Asia are excluded from the bidding,” the president confirmed.',
  ];

  it.each(junk.map((text) => [text]))('rejects junk: %s', (text) => {
    expect(isJunkSentence(text)).toBe(true);
  });

  it.each(legitimate.map((text) => [text]))('keeps legitimate: %s', (text) => {
    expect(isJunkSentence(text)).toBe(false);
  });
});

describe('@no-llm synthesis/extractEligibleClaims junk gate integration', () => {
  it('drops chrome sentences from claims even when grammatical', () => {
    const texts = claimTexts([
      doc(
        'Electric vehicle sales declined 28% across the US in 2026 nationwide. 01:18:30 | MUST READS EV sales were strong this quarter too.',
      ),
    ]);
    expect(texts.some((text) => text.includes('MUST READS'))).toBe(false);
    expect(texts.some((text) => text.includes('28%'))).toBe(true);
  });

  it('drops editorial questions', () => {
    const texts = claimTexts([
      doc(
        'Electric vehicle sales declined 28% across the US in 2026 nationwide. Are EV sales in the US finally about to turn the corner this year?',
      ),
    ]);
    expect(texts.some((text) => text.endsWith('?'))).toBe(false);
  });
});

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
