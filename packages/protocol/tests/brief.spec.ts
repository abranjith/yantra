import { describe, expect, it } from 'vitest';

import { Brief, BriefFacets, KeyFinding } from '../src/index.js';

import { makeBrief, makeSource } from './brief-factories.js';

/** ESC (0x1B) and CSI (0x9B) bytes, built via char codes to keep this file ANSI-free. */
const ESC = String.fromCharCode(0x1b);
const CSI = String.fromCharCode(0x9b);

/** Plan §5 sketch, completed where the plan elides values with "…". */
const planSketchBrief = {
  brief_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  task_id: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
  schema_version: '0.2',
  title: 'Cheapest Sony WH-1000XM5 today',
  overview:
    'Lowest price is $328 at Amazon (was $399). 3 of 6 retailers in stock; prices rose ~4% this week. [1][3]',
  key_findings: [
    {
      text: 'Amazon — $328, in stock, free shipping',
      citations: [1],
      facet: { price: 328, currency: 'USD', in_stock: true },
    },
    { text: 'Best Buy — $349, in stock', citations: [2], facet: { price: 349, in_stock: true } },
  ],
  sections: [
    { heading: 'Price & availability', body_md: 'Amazon leads at $328. [1]', citations: [1, 2, 3] },
    {
      heading: 'Caveats',
      body_md: 'Walmart listing is a third-party seller. [3]',
      citations: [3],
    },
  ],
  facets: {
    comparison: {
      columns: ['Retailer', 'Price', 'Stock'],
      rows: [
        ['Amazon', '$328', true],
        ['Best Buy', '$349', true],
        ['Walmart', '$355', false],
      ],
    },
  },
  sources: [
    {
      n: 1,
      url: 'https://amazon.com/dp/B09XS7JWHH',
      host: 'amazon.com',
      title: 'Sony WH-1000XM5 Wireless Headphones',
      fetched_at: '2026-07-01T10:00:00.000Z',
      published_at: null,
    },
    {
      n: 2,
      url: 'https://bestbuy.com/site/sony-wh-1000xm5',
      host: 'bestbuy.com',
      title: 'Sony WH-1000XM5 - Best Buy',
      fetched_at: '2026-07-01T10:00:05.000Z',
      published_at: null,
    },
    {
      n: 3,
      url: 'https://walmart.com/ip/sony-wh-1000xm5',
      host: 'walmart.com',
      title: null,
      fetched_at: '2026-07-01T10:00:09.000Z',
      published_at: '2026-06-28T00:00:00.000Z',
    },
  ],
  metadata: {
    search_provider: 'tavily',
    synthesis: 'llm',
    deterministic_fallback_used: false,
    coverage: 0.83,
    freshness: 'today',
    usage: { input_tokens: 5120, output_tokens: 640, cost_usd: 0.021 },
    run_id: '01ARZ3NDEKTSV4RRFFQ69G5FAX',
  },
  notices: [{ source: 'example.com', reason: 'fetch timed out', kind: 'fetch_failed' }],
};

describe('@no-llm brief schema', () => {
  it('parses the plan §5 sketch document', () => {
    const result = Brief.safeParse(planSketchBrief);
    expect(result.success).toBe(true);
  });

  it('applies defaults for editorial, facet, final_url, and citation_verdict', () => {
    const parsed = Brief.parse(planSketchBrief);
    expect(parsed.key_findings[0]?.editorial).toBe(false);
    expect(parsed.sources[0]?.final_url).toBeNull();
    expect(parsed.metadata.citation_verdict).toBeNull();
  });

  it('fails a citation to a missing source with the offending path', () => {
    const brief = makeBrief({
      key_findings: [{ text: 'claim', citations: [1, 9], editorial: false, facet: null }],
    });

    const result = Brief.safeParse(brief);
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join('.'));
      expect(paths).toContain('key_findings.0.citations.1');
    }
  });

  it('fails a section citation to a missing source with the offending path', () => {
    const brief = makeBrief({
      sections: [{ heading: 'Detail', body_md: 'body', citations: [7] }],
    });

    const result = Brief.safeParse(brief);
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join('.'));
      expect(paths).toContain('sections.0.citations.0');
    }
  });

  it('defaults finding children to an empty array when omitted', () => {
    const parsed = Brief.parse(planSketchBrief);
    expect(parsed.key_findings[0]?.children).toEqual([]);
  });

  it('rejects a child finding with empty or dangling citations', () => {
    const empty = makeBrief({
      key_findings: [
        {
          text: 'parent',
          citations: [1],
          editorial: false,
          facet: null,
          children: [{ text: 'child', citations: [] }],
        },
      ],
    });
    const dangling = makeBrief({
      key_findings: [
        {
          text: 'parent',
          citations: [1],
          editorial: false,
          facet: null,
          children: [{ text: 'child', citations: [9] }],
        },
      ],
    });

    expect(Brief.safeParse(empty).success).toBe(false);
    const result = Brief.safeParse(dangling);
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join('.'));
      expect(paths).toContain('key_findings.0.children.0.citations.0');
    }
  });

  it('fails non-contiguous source numbering', () => {
    const brief = makeBrief({
      sources: [makeSource(1), { ...makeSource(2), n: 3 }],
    });

    const result = Brief.safeParse(brief);
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join('.'));
      expect(paths).toContain('sources.1.n');
    }
  });

  it('fails source numbering that does not start at 1', () => {
    const brief = makeBrief({ sources: [{ ...makeSource(1), n: 2 }], key_findings: [] });

    expect(Brief.safeParse(brief).success).toBe(false);
  });

  it('fails duplicate normalized source URLs', () => {
    const first = makeSource(1);
    const duplicate = { ...makeSource(2), url: first.url };

    const result = Brief.safeParse(makeBrief({ sources: [first, duplicate] }));
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join('.'));
      expect(paths).toContain('sources.1.url');
    }
  });

  it('treats final_url as the normalized identity for deduplication', () => {
    const first = { ...makeSource(1), final_url: 'https://landing.example.com/product' };
    const second = { ...makeSource(2), final_url: 'https://landing.example.com/product' };

    const result = Brief.safeParse(makeBrief({ sources: [first, second] }));
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join('.'));
      expect(paths).toContain('sources.1.final_url');
    }
  });

  it('allows distinct urls that redirect to distinct final_urls', () => {
    const first = { ...makeSource(1), final_url: 'https://a.example.com/landing' };
    const second = { ...makeSource(2), final_url: 'https://b.example.com/landing' };

    expect(Brief.safeParse(makeBrief({ sources: [first, second] })).success).toBe(true);
  });

  it('fails an uncited non-editorial finding', () => {
    const brief = makeBrief({
      key_findings: [{ text: 'unbacked claim', citations: [], editorial: false, facet: null }],
    });

    const result = Brief.safeParse(brief);
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join('.'));
      expect(paths).toContain('key_findings.0.citations');
    }
  });

  it('passes an editorial finding with zero citations', () => {
    const brief = makeBrief({
      key_findings: [
        { text: 'our take: wait for a sale', citations: [], editorial: true, facet: null },
      ],
    });

    expect(Brief.safeParse(brief).success).toBe(true);
  });

  it('rejects ANSI escapes in overview', () => {
    const brief = makeBrief({ overview: `styled ${ESC}[31mred${ESC}[0m text [1]` });
    expect(Brief.safeParse(brief).success).toBe(false);
  });

  it('rejects ANSI escapes in section body_md and key finding text', () => {
    const inBody = makeBrief({
      sections: [{ heading: 'H', body_md: `${ESC}[1mbold${ESC}[0m`, citations: [1] }],
    });
    const inFinding = makeBrief({
      key_findings: [
        { text: `${CSI}31mstyled text`, citations: [1], editorial: false, facet: null },
      ],
    });

    expect(Brief.safeParse(inBody).success).toBe(false);
    expect(Brief.safeParse(inFinding).success).toBe(false);
  });

  it('fails comparison rows whose length differs from columns', () => {
    const brief = makeBrief({
      facets: {
        comparison: {
          columns: ['Retailer', 'Price'],
          rows: [['Amazon', '$328', 'extra-cell']],
        },
      },
    });

    const result = Brief.safeParse(brief);
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join('.'));
      expect(paths).toContain('facets.comparison.rows.0');
    }
  });

  it('accepts null metadata sub-objects and null facets', () => {
    const brief = makeBrief({
      facets: null,
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
    });

    expect(Brief.safeParse(brief).success).toBe(true);
  });

  it('accepts a minimal empty document (no findings, sections, sources, or notices)', () => {
    const brief = makeBrief({
      key_findings: [],
      sections: [],
      facets: null,
      sources: [],
      notices: [],
    });

    expect(Brief.safeParse(brief).success).toBe(true);
  });

  it('rejects a wrong schema_version literal', () => {
    expect(Brief.safeParse({ ...makeBrief(), schema_version: '0.1' }).success).toBe(false);
  });

  it('rejects non-ULID brief and task ids', () => {
    expect(Brief.safeParse(makeBrief({ brief_id: 'not-a-ulid' })).success).toBe(false);
    expect(Brief.safeParse(makeBrief({ task_id: 'lowercase01arz3ndektsv4rrf' })).success).toBe(
      false,
    );
  });

  it('rejects an empty title and malformed source fields', () => {
    expect(Brief.safeParse(makeBrief({ title: '' })).success).toBe(false);
    expect(
      Brief.safeParse(makeBrief({ sources: [{ ...makeSource(1), url: 'not-a-url' }] })).success,
    ).toBe(false);
    expect(
      Brief.safeParse(makeBrief({ sources: [{ ...makeSource(1), fetched_at: 'yesterday' }] }))
        .success,
    ).toBe(false);
  });

  it('round-trips a valid Brief through JSON serialization', () => {
    const parsed = Brief.parse(planSketchBrief);
    const reparsed = Brief.parse(JSON.parse(JSON.stringify(parsed)));
    expect(reparsed).toEqual(parsed);
  });

  it('validates BriefFacets row arity standalone', () => {
    const bad = BriefFacets.safeParse({
      comparison: { columns: ['A'], rows: [['x', 'y']] },
    });
    expect(bad.success).toBe(false);

    const good = BriefFacets.safeParse({ comparison: null });
    expect(good.success).toBe(true);
  });

  it('validates KeyFinding facet scalars standalone', () => {
    const good = KeyFinding.safeParse({
      text: 'finding',
      citations: [1],
      facet: { price: 328, in_stock: true, note: null, retailer: 'Amazon' },
    });
    expect(good.success).toBe(true);

    const nested = KeyFinding.safeParse({
      text: 'finding',
      citations: [1],
      facet: { nested: { deep: true } },
    });
    expect(nested.success).toBe(false);
  });

  it('rejects zero and negative citation numbers', () => {
    const zero = makeBrief({
      key_findings: [{ text: 'x', citations: [0], editorial: false, facet: null }],
    });
    const negative = makeBrief({
      sections: [{ heading: 'H', body_md: 'b', citations: [-1] }],
    });

    expect(Brief.safeParse(zero).success).toBe(false);
    expect(Brief.safeParse(negative).success).toBe(false);
  });
});

describe('@no-llm brief schema — evidence-first additions (FEAT-FP-001)', () => {
  it('accepts the source_excluded and limited_evidence notice kinds', () => {
    const brief = makeBrief({
      notices: [
        {
          source: 'nasa.example.gov',
          reason: 'no overlap with query terms',
          kind: 'source_excluded',
        },
        {
          source: 'synthesis',
          reason: 'fewer relevant findings than requested',
          kind: 'limited_evidence',
        },
      ],
    });
    expect(Brief.safeParse(brief).success).toBe(true);
  });

  it('rejects an unknown notice kind', () => {
    const brief = makeBrief({
      notices: [{ source: 'x', reason: 'y', kind: 'totally_made_up' as never }],
    });
    expect(Brief.safeParse(brief).success).toBe(false);
  });

  it('accepts a populated metadata.evidence block', () => {
    const brief = makeBrief({
      metadata: {
        ...makeBrief().metadata,
        evidence: { candidate_claims: 40, accepted_claims: 6, excluded_sources: 3 },
      },
    });
    const parsed = Brief.safeParse(brief);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.metadata.evidence).toEqual({
        candidate_claims: 40,
        accepted_claims: 6,
        excluded_sources: 3,
      });
    }
  });

  it('defaults metadata.evidence to null when omitted', () => {
    const { evidence: _omitted, ...metadataWithoutEvidence } = makeBrief().metadata;
    const parsed = Brief.parse(makeBrief({ metadata: metadataWithoutEvidence as never }));
    expect(parsed.metadata.evidence).toBeNull();
  });

  it('rejects negative evidence counts', () => {
    const brief = makeBrief({
      metadata: {
        ...makeBrief().metadata,
        evidence: { candidate_claims: -1, accepted_claims: 0, excluded_sources: 0 },
      },
    });
    expect(Brief.safeParse(brief).success).toBe(false);
  });
});
