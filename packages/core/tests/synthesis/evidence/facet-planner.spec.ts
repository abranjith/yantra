import { describe, expect, it } from 'vitest';

import { WinkAnalyzer } from '../../../src/synthesis/analysis/wink-analyzer.js';
import { clusterSources } from '../../../src/synthesis/clustering.js';
import { buildFacetTable } from '../../../src/synthesis/evidence/facet-planner.js';
import { buildQueryProfile } from '../../../src/synthesis/evidence/query-profile.js';
import type { SynthesisDoc } from '../../../src/synthesis/types.js';

const analyzer = new WinkAnalyzer();

function doc(url: string, text: string): SynthesisDoc {
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

function table(query: string, docs: readonly SynthesisDoc[]) {
  const profile = buildQueryProfile(query, analyzer);
  const { clusters, sources } = clusterSources(docs);
  return buildFacetTable(docs, clusters, sources, profile, analyzer);
}

describe('@no-llm synthesis/buildFacetTable price intent', () => {
  const docs = [
    doc(
      'https://amazon.example.com/xm5',
      'The Sony WH-1000XM5 headphones are on sale for $328 at Amazon today. Free shipping applies over $35.',
    ),
    doc(
      'https://bestbuy.example.com/xm5',
      'Best Buy lists the Sony WH-1000XM5 headphones at $349 with store pickup. A protection plan adds $59.',
    ),
  ];

  it('builds a Price column from entity-anchored money values', () => {
    const facets = table('cheapest Sony WH-1000XM5 headphones', docs);
    expect(facets).not.toBeNull();
    expect(facets!.columns).toEqual(['Source', 'Price']);
    const values = facets!.rows.map((row) => row[1]);
    // Picks the product-anchored prices ($328, $349), not the $35 shipping
    // threshold or the $59 protection plan (those sentences name no target term).
    expect(values).toContain('$328');
    expect(values).toContain('$349');
    expect(values).not.toContain('$35');
    expect(values).not.toContain('$59');
  });
});

describe('@no-llm synthesis/buildFacetTable rate/trend intent', () => {
  const docs = [
    doc(
      'https://coxauto.example.com/ev',
      'US electric vehicle sales fell 28% in 2026 as demand cooled. A luxury EV separately listed at $94,900 that year.',
    ),
    doc(
      'https://autonews.example.com/ev',
      'EV car sales in the US dropped 19% in 2026 according to registration data across every state.',
    ),
  ];

  it('builds a percentage Change column and never a Price column', () => {
    const facets = table('State of EV car sales in US in 2026', docs);
    expect(facets).not.toBeNull();
    expect(facets!.columns).toEqual(['Source', 'Metric', 'Change']);
    expect(facets!.columns).not.toContain('Price');
    const cells = facets!.rows.flat();
    // The unanchored, wrong-kind $94,900 never reaches the table.
    expect(cells).not.toContain('$94,900');
    expect(cells).toContain('Sales decline');
    expect(cells.some((cell) => cell === '28%')).toBe(true);
    expect(cells.some((cell) => cell === '19%')).toBe(true);
  });
});

describe('@no-llm synthesis/buildFacetTable non-facet intents', () => {
  it('returns null for a general-intent query even when sources contain prices', () => {
    const docs = [
      doc(
        'https://a.example.com/1',
        'Photosynthesis converts sunlight into energy. A textbook on it costs $40 online.',
      ),
      doc(
        'https://b.example.com/1',
        'The process of photosynthesis sustains most life. Lab kits sell for $75 each.',
      ),
    ];
    expect(table('photosynthesis explained simply', docs)).toBeNull();
  });

  it('returns null when only one source has an anchored value', () => {
    const docs = [
      doc('https://a.example.com/1', 'The Sony WH-1000XM5 headphones cost $328 at Amazon today.'),
      doc(
        'https://b.example.com/1',
        'A review of the Sony WH-1000XM5 headphones praised the sound.',
      ),
    ];
    expect(table('cheapest Sony WH-1000XM5 headphones', docs)).toBeNull();
  });
});

describe('@no-llm synthesis/buildFacetTable determinism', () => {
  it('produces an identical table across repeated calls', () => {
    const docs = [
      doc(
        'https://amazon.example.com/xm5',
        'The Sony WH-1000XM5 headphones sell for $328 at Amazon.',
      ),
      doc(
        'https://bestbuy.example.com/xm5',
        'Best Buy lists the Sony WH-1000XM5 headphones at $349.',
      ),
    ];
    expect(table('cheapest Sony WH-1000XM5 headphones', docs)).toEqual(
      table('cheapest Sony WH-1000XM5 headphones', docs),
    );
  });
});
