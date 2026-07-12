import { describe, expect, it } from 'vitest';

import { WinkAnalyzer } from '../../../src/synthesis/analysis/wink-analyzer.js';
import { buildQueryProfile } from '../../../src/synthesis/evidence/query-profile.js';
import type { QueryIntent, TimeSensitivity } from '../../../src/synthesis/evidence/types.js';

const analyzer = new WinkAnalyzer();

interface Case {
  readonly query: string;
  readonly intent: QueryIntent;
  readonly time: TimeSensitivity;
}

const CASES: readonly Case[] = [
  { query: 'cheapest Sony WH-1000XM5 today', intent: 'price_lookup', time: 'current' },
  { query: 'how much does a Tesla Model 3 cost', intent: 'price_lookup', time: 'timeless' },
  { query: 'best price on an iPhone 15', intent: 'comparison', time: 'timeless' },
  { query: 'iPhone 15 Pro vs Samsung Galaxy S24', intent: 'comparison', time: 'timeless' },
  { query: 'compare electric SUV lease deals', intent: 'comparison', time: 'timeless' },
  { query: 'State of EV car sales in US in 2026', intent: 'rate_or_trend', time: 'recent' },
  { query: 'EV market share growth rate', intent: 'rate_or_trend', time: 'timeless' },
  {
    query: 'how many electric cars were sold last quarter',
    intent: 'rate_or_trend',
    time: 'timeless',
  },
  { query: 'what is the capital of France', intent: 'factual_lookup', time: 'timeless' },
  { query: 'when did the Berlin Wall fall', intent: 'factual_lookup', time: 'timeless' },
  { query: 'Barack Obama', intent: 'entity_profile', time: 'timeless' },
  { query: 'Tesla Model 3', intent: 'entity_profile', time: 'timeless' },
  { query: 'latest news on AI regulation', intent: 'general', time: 'current' },
  { query: 'photosynthesis explained simply', intent: 'general', time: 'timeless' },
];

describe('@no-llm synthesis/buildQueryProfile intent + time', () => {
  for (const { query, intent, time } of CASES) {
    it(`classifies "${query}" as ${intent} / ${time}`, () => {
      const profile = buildQueryProfile(query, analyzer);
      expect(profile.intent).toBe(intent);
      expect(profile.timeSensitivity).toBe(time);
    });
  }
});

describe('@no-llm synthesis/buildQueryProfile evidence kinds + facets', () => {
  it('requires money and plans a price facet for a price lookup', () => {
    const profile = buildQueryProfile('cheapest Sony WH-1000XM5 today', analyzer);
    expect(profile.requiredEvidenceKinds).toEqual(['money']);
    expect(profile.facetPlan).toEqual([{ column: 'Price', entityKind: 'money' }]);
  });

  it('requires percent and quantity for a rate/trend query', () => {
    const profile = buildQueryProfile('State of EV car sales in US in 2026', analyzer);
    expect(profile.requiredEvidenceKinds).toEqual(['percent', 'quantity']);
    expect(profile.facetPlan).toEqual([{ column: 'Change', entityKind: 'percent' }]);
  });

  it('plans no facet and requires no numeric kind for a factual lookup', () => {
    const profile = buildQueryProfile('what is the capital of France', analyzer);
    expect(profile.requiredEvidenceKinds).toEqual([]);
    expect(profile.facetPlan).toEqual([]);
  });
});

describe('@no-llm synthesis/buildQueryProfile terms + entities', () => {
  it('lifts target entities from the query proper nouns', () => {
    const profile = buildQueryProfile('State of EV car sales in US in 2026', analyzer);
    expect(profile.targetEntities).toContain('ev');
    expect(profile.targetEntities).toContain('us');
  });

  it('collects informative must-match lemmas and drops stopwords', () => {
    const profile = buildQueryProfile('State of EV car sales in US in 2026', analyzer);
    expect(profile.mustMatchTerms).toContain('sale');
    expect(profile.mustMatchTerms).toContain('car');
    expect(profile.mustMatchTerms).not.toContain('of');
    expect(profile.mustMatchTerms).not.toContain('in');
  });

  it('deduplicates target entities and must-match terms', () => {
    const profile = buildQueryProfile('Tesla Tesla Model 3', analyzer);
    expect(new Set(profile.mustMatchTerms).size).toBe(profile.mustMatchTerms.length);
    expect(new Set(profile.targetEntities).size).toBe(profile.targetEntities.length);
  });
});

describe('@no-llm synthesis/buildQueryProfile determinism', () => {
  it('produces a deep-equal profile across repeated calls', () => {
    const query = 'State of EV car sales in US in 2026';
    expect(buildQueryProfile(query, analyzer)).toEqual(buildQueryProfile(query, analyzer));
  });
});
