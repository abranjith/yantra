import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { BriefFacets } from '@yantra/protocol';
import { describe, expect, it } from 'vitest';

import { clusterSources } from '../../src/synthesis/clustering.js';
import { buildComparisonFacet } from '../../src/synthesis/facets.js';
import type { SynthesisDoc, SynthesisInput } from '../../src/synthesis/types.js';

const priceCorpus = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures', 'price-corpus.json'), 'utf8'),
) as SynthesisInput;

function doc(overrides: Partial<SynthesisDoc> & { url: string; text: string }): SynthesisDoc {
  return {
    finalUrl: null,
    host: new URL(overrides.url).hostname,
    title: 'Fixture',
    fetchedAt: '2026-06-01T00:00:00.000Z',
    publishedAt: null,
    excerpt: null,
    ...overrides,
  };
}

function facetFor(docs: readonly SynthesisDoc[]): BriefFacets | null {
  const { clusters, sources } = clusterSources(docs);
  return buildComparisonFacet(docs, clusters, sources);
}

describe('@no-llm synthesis/buildComparisonFacet', () => {
  it('builds a price comparison with one row per retailer', () => {
    const facet = facetFor(priceCorpus.docs);

    expect(facet).not.toBeNull();
    expect(facet!.comparison).not.toBeNull();
    expect(facet!.comparison!.columns[0]).toBe('Source');
    expect(facet!.comparison!.columns).toContain('Price');
    expect(facet!.comparison!.rows).toHaveLength(priceCorpus.docs.length);

    const hosts = facet!.comparison!.rows.map((row) => row[0]);
    expect(hosts).toEqual(['amazon.example.com', 'bestbuy.example.com', 'walmart.example.com']);

    const prices = facet!.comparison!.rows.map((row) => row[1]);
    expect(prices).toEqual(['$328', '$349', '$335']);
  });

  it('emits a schema-valid facets block that matches column arity', () => {
    const facet = facetFor(priceCorpus.docs);
    const parsed = BriefFacets.safeParse(facet);

    expect(parsed.success).toBe(true);
    const width = facet!.comparison!.columns.length;
    for (const row of facet!.comparison!.rows) {
      expect(row).toHaveLength(width);
    }
  });

  it('returns null for a non-comparative corpus with no shared numeric attribute', () => {
    const facet = facetFor([
      doc({
        url: 'https://a.example.com/1',
        text: 'The museum unveiled a new sculpture garden this spring for visitors to explore.',
      }),
      doc({
        url: 'https://b.example.com/1',
        text: 'A documentary about coral reefs premiered at the film festival last weekend.',
      }),
    ]);

    expect(facet).toBeNull();
  });

  it('returns null when only one source exposes a numeric attribute', () => {
    const facet = facetFor([
      doc({ url: 'https://a.example.com/1', text: 'The gadget costs $199 at launch this month.' }),
      doc({
        url: 'https://b.example.com/1',
        text: 'Reviewers praised the build quality and the long battery endurance overall.',
      }),
    ]);

    expect(facet).toBeNull();
  });

  it('returns null for empty and single-doc corpora', () => {
    expect(facetFor([])).toBeNull();
    expect(
      facetFor([doc({ url: 'https://a.example.com/1', text: 'It costs $50 today only.' })]),
    ).toBeNull();
  });

  it('builds a percentage comparison when sources share a percent attribute', () => {
    const facet = facetFor([
      doc({
        url: 'https://a.example.com/1',
        text: 'Adoption grew 25% year over year according to the first survey of buyers.',
      }),
      doc({
        url: 'https://b.example.com/1',
        text: 'A competing report measured adoption growth at 30% over the same annual period.',
      }),
    ]);

    expect(facet).not.toBeNull();
    expect(facet!.comparison!.columns).toContain('Percentage');
    expect(facet!.comparison!.rows.map((row) => row[1])).toEqual(['25%', '30%']);
  });
});
