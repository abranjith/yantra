/**
 * Shared Brief test fixtures (FEAT-015).
 *
 * `canonicalBrief` is the one checked-in golden Brief exercised across every
 * render surface — terminal (all detail × color combinations), `brief.md`,
 * `brief.html`, and `--json`. Living in `@yantra/test-helpers` keeps a single
 * source of truth for the renderer snapshot suite (core/cli unit tests) *and*
 * the e2e seam tests, so a Brief-shape change surfaces in exactly one place.
 *
 * To regenerate the snapshots after intentionally editing this fixture, run
 * `pnpm snapshots:update` (see the FEAT-015 render suites). A stray edit here
 * that changes rendered output should fail multiple snapshot suites — that is
 * the drift-detection contract.
 *
 * The fixture is a `deterministic`-synthesis Brief so it is byte-stable in the
 * `@no-llm` CI leg. It is schema-valid by construction (contiguous sources,
 * every citation resolves, editorial marks the one uncited finding).
 */

import type { Brief, BriefSource } from '@yantra/protocol';

/** Builds a numbered {@link BriefSource} with sensible defaults. */
export const makeSource = (n: number, overrides: Partial<BriefSource> = {}): BriefSource => ({
  n,
  url: `https://source-${n}.example.com/page`,
  final_url: null,
  host: `source-${n}.example.com`,
  title: `Source ${n}`,
  fetched_at: '2026-07-01T10:00:00.000Z',
  published_at: null,
  ...overrides,
});

/**
 * Builds a minimal schema-valid {@link Brief}, merging `overrides` over a
 * one-source / one-finding base. Handy for targeted edge-case fixtures
 * (empty sections, null facets, notice-only) without restating the whole
 * document.
 */
export const makeBrief = (overrides: Partial<Brief> = {}): Brief => {
  const base: Brief = {
    brief_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    task_id: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
    schema_version: '0.2',
    title: 'Test Brief',
    overview: 'Answer-first overview. [1]',
    key_findings: [{ text: 'Finding one [1]', citations: [1], editorial: false, facet: null }],
    sections: [],
    facets: null,
    sources: [makeSource(1)],
    metadata: {
      search_provider: null,
      synthesis: 'deterministic',
      deterministic_fallback_used: false,
      coverage: null,
      freshness: null,
      citation_verdict: null,
      usage: null,
      run_id: null,
    },
    notices: [],
  };

  return { ...base, ...overrides };
};

/**
 * The canonical golden Brief: a realistic price-comparison document with an
 * answer-first overview, cited + editorial findings, detail sections, a
 * comparison facet, three numbered sources, and one honest notice. This is
 * the fixture the whole FEAT-015 render suite pins against.
 */
export const canonicalBrief: Brief = {
  brief_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  task_id: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
  schema_version: '0.2',
  title: 'Cheapest Sony WH-1000XM5 today',
  overview:
    'Lowest price is **$328** at Amazon (down from a $399 list price). All three ' +
    'tracked retailers list the WH-1000XM5, and prices have risen roughly 4% this ' +
    'week. [1][3]',
  key_findings: [
    {
      text: 'Amazon — $328, in stock, free shipping [1]',
      citations: [1],
      editorial: false,
      facet: { price: 328, currency: 'USD', in_stock: true },
    },
    {
      text: 'Best Buy — $349, in stock [2]',
      citations: [2],
      editorial: false,
      facet: { price: 349, in_stock: true },
    },
    {
      text: 'Walmart — $342 via a third-party seller [3]',
      citations: [3],
      editorial: false,
      facet: { price: 342, in_stock: true },
    },
    {
      text: 'Prices have trended upward since last week, so buying now is reasonable.',
      citations: [],
      editorial: true,
      facet: null,
    },
  ],
  sections: [
    {
      heading: 'Price & availability',
      body_md:
        'All three major retailers currently stock the WH-1000XM5. Amazon has the ' +
        'lowest sticker at $328, down from a $399 list price, followed by Walmart at ' +
        '$342 and Best Buy at $349. [1][2][3]',
      citations: [1, 2, 3],
    },
    {
      heading: 'Caveats',
      body_md:
        'The Walmart listing is fulfilled by a third-party seller, so warranty terms ' +
        'differ from a first-party sale. [3]',
      citations: [3],
    },
  ],
  facets: {
    comparison: {
      columns: ['Retailer', 'Price', 'In stock'],
      rows: [
        ['Amazon', '$328', true],
        ['Best Buy', '$349', true],
        ['Walmart', '$342', true],
      ],
    },
  },
  sources: [
    {
      n: 1,
      url: 'https://www.amazon.com/sony-wh-1000xm5',
      final_url: null,
      host: 'amazon.com',
      title: 'Sony WH-1000XM5 Wireless Headphones — Amazon',
      fetched_at: '2026-07-01T09:00:00.000Z',
      published_at: '2026-06-28T00:00:00.000Z',
    },
    {
      n: 2,
      url: 'https://www.bestbuy.com/sony-wh-1000xm5',
      final_url: null,
      host: 'bestbuy.com',
      title: 'Sony WH-1000XM5 | Best Buy',
      fetched_at: '2026-07-01T09:00:05.000Z',
      published_at: null,
    },
    {
      n: 3,
      url: 'https://www.walmart.com/ip/sony-wh-1000xm5',
      final_url: null,
      host: 'walmart.com',
      title: 'Sony WH-1000XM5 Headphones - Walmart',
      fetched_at: '2026-07-01T09:00:10.000Z',
      published_at: null,
    },
  ],
  metadata: {
    search_provider: 'tavily',
    synthesis: 'deterministic',
    deterministic_fallback_used: false,
    coverage: 1,
    freshness: 'today',
    citation_verdict: { claims_checked: 6, flagged: 0, stripped: 0 },
    usage: null,
    run_id: '01ARZ3NDEKTSV4RRFFQ69G5FAX',
  },
  notices: [
    {
      source: 'example-blog.com',
      reason: 'fetch timed out after 8000ms',
      kind: 'fetch_failed',
    },
  ],
};
