import { describe, expect, it } from 'vitest';

import { WinkAnalyzer } from '../../../src/synthesis/analysis/wink-analyzer.js';
import { buildQueryProfile } from '../../../src/synthesis/evidence/query-profile.js';
import { gateRelevance } from '../../../src/synthesis/evidence/relevance.js';
import type { SynthesisDoc } from '../../../src/synthesis/types.js';

const analyzer = new WinkAnalyzer();
const QUERY = 'State of EV car sales in US in 2026';
const profile = buildQueryProfile(QUERY, analyzer);

function doc(overrides: Partial<SynthesisDoc> & { url: string; text: string }): SynthesisDoc {
  return {
    finalUrl: null,
    host: new URL(overrides.url).hostname,
    title: null,
    fetchedAt: '2026-06-01T00:00:00.000Z',
    publishedAt: null,
    excerpt: null,
    ...overrides,
  };
}

// An EV-brief-shaped corpus: two on-topic sources plus the exact off-topic
// intrusions the real failure artifact exhibited.
const docs: readonly SynthesisDoc[] = [
  doc({
    url: 'https://coxauto.example.com/ev',
    host: 'coxauto.example.com',
    text: 'Electric vehicle sales in the US rose 28% in 2026 as Cox Automotive reported record car adoption. EV market share grew across every state as buyers embraced electric cars.',
  }),
  doc({
    url: 'https://autonews.example.com/2026',
    host: 'autonews.example.com',
    text: 'US new car sales data for 2026 shows EVs reaching a record share. Analysts say electric vehicle demand accelerated nationwide across every state.',
  }),
  doc({
    url: 'https://nasa.example.gov/mars',
    host: 'nasa.example.gov',
    text: 'NASA scientists announced new findings about the surface of Mars. The rover collected rock samples that suggest ancient water once flowed across the red planet.',
  }),
  doc({
    url: 'https://betternurse.example.org/costs',
    host: 'betternurse.example.org',
    text: 'Nursing home costs across the US keep climbing steadily. The average monthly fee for assisted living care reached a record high, with families paying more for elderly relatives.',
  }),
  doc({
    url: 'https://leegality.example.com/esign',
    host: 'leegality.example.com',
    text: 'Electronic signatures are legally valid under the IT Act. Digital contract signing platforms help businesses e-sign documents securely and remain compliant.',
  }),
];

describe('@no-llm synthesis/gateRelevance', () => {
  it('keeps the on-topic EV sources', () => {
    const { keptDocIndexes } = gateRelevance(docs, QUERY, profile, analyzer);
    expect(keptDocIndexes).toContain(0);
    expect(keptDocIndexes).toContain(1);
  });

  it('excludes the off-topic NASA, nursing, and legal sources', () => {
    const { keptDocIndexes, exclusions } = gateRelevance(docs, QUERY, profile, analyzer);
    const excludedHosts = exclusions.map((exclusion) => exclusion.host);

    expect(keptDocIndexes).not.toContain(2);
    expect(keptDocIndexes).not.toContain(3);
    expect(keptDocIndexes).not.toContain(4);
    expect(excludedHosts).toEqual(
      expect.arrayContaining([
        'nasa.example.gov',
        'betternurse.example.org',
        'leegality.example.com',
      ]),
    );
  });

  it('records a human-readable reason naming the query terms', () => {
    const { exclusions } = gateRelevance(docs, QUERY, profile, analyzer);
    const nasa = exclusions.find((exclusion) => exclusion.host === 'nasa.example.gov');
    expect(nasa).toBeDefined();
    expect(nasa!.reason).toMatch(/overlap with query terms/u);
    expect(nasa!.docIndex).toBe(2);
  });

  it('keeps every document when the query has no informative terms', () => {
    const emptyProfile = buildQueryProfile('the of a to', analyzer);
    const { keptDocIndexes, exclusions } = gateRelevance(
      docs,
      'the of a to',
      emptyProfile,
      analyzer,
    );
    expect(keptDocIndexes).toHaveLength(docs.length);
    expect(exclusions).toEqual([]);
  });

  it('honors overridden thresholds', () => {
    // With an impossible floor, every source is excluded.
    const strict = gateRelevance(docs, QUERY, profile, analyzer, {
      minCoverage: 2,
      minSimilarity: 2,
    });
    expect(strict.keptDocIndexes).toEqual([]);
    expect(strict.exclusions).toHaveLength(docs.length);

    // Similarity alone can carry an on-topic source when coverage is disabled.
    const bySimilarity = gateRelevance(docs, QUERY, profile, analyzer, {
      minCoverage: 2,
      minSimilarity: 0.2,
    });
    expect(bySimilarity.keptDocIndexes).toContain(0);
    expect(bySimilarity.keptDocIndexes).toContain(1);
    expect(bySimilarity.exclusions.map((exclusion) => exclusion.host)).toContain(
      'nasa.example.gov',
    );
  });

  it('is deterministic across repeated calls', () => {
    const first = gateRelevance(docs, QUERY, profile, analyzer);
    const second = gateRelevance(docs, QUERY, profile, analyzer);
    expect(first).toEqual(second);
  });
});
