/**
 * fast-check arbitraries for the Brief document.
 *
 * Exported for cross-feature reuse: FEAT-014's citation-faithfulness
 * golden/property suites build on these —
 * - `validBriefArb` generates structurally consistent Briefs (sources
 *   numbered 1..N, citations drawn only from that range, editorial set
 *   whenever citations are empty) that must always pass `validateBrief`.
 * - `mutatedBriefArb` applies one random corruption (dangling citation,
 *   duplicate URL, numbering gap, ANSI injection, uncited finding) to a
 *   valid Brief; the validator must reject every sample with at least one
 *   actionable issue path and must never throw.
 */

import fc from 'fast-check';

import type {
  Brief,
  BriefFacets,
  BriefMetadata,
  BriefNotice,
  BriefSource,
  KeyFinding,
  Section,
} from '../../src/index.js';

/** ESC (0x1B) byte, built via char code to keep this file ANSI-free. */
const ESC = String.fromCharCode(0x1b);
const CSI = String.fromCharCode(0x9b);

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const ulidArb: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...CROCKFORD.split('')), { minLength: 26, maxLength: 26 })
  .map((chars) => chars.join(''));

const containsAnsi = (value: string): boolean => value.includes(ESC) || value.includes(CSI);

const textArb = (minLength: number): fc.Arbitrary<string> =>
  fc.string({ minLength, maxLength: 60 }).filter((value) => !containsAnsi(value));

const isoDateArb: fc.Arbitrary<string> = fc
  .date({
    min: new Date('2020-01-01T00:00:00.000Z'),
    max: new Date('2030-12-31T23:59:59.000Z'),
    noInvalidDate: true,
  })
  .map((date) => date.toISOString());

const facetScalarArb: fc.Arbitrary<string | number | boolean | null> = fc.oneof(
  textArb(0),
  fc.integer(),
  fc.boolean(),
  fc.constant(null),
);

const citationsArb = (sourceCount: number): fc.Arbitrary<number[]> =>
  sourceCount === 0
    ? fc.constant([])
    : fc.array(fc.integer({ min: 1, max: sourceCount }), { maxLength: 4 });

const childFindingsArb = (sourceCount: number): fc.Arbitrary<KeyFinding['children']> =>
  sourceCount === 0
    ? fc.constant([])
    : fc.array(
        fc.record({
          text: textArb(1),
          citations: citationsArb(sourceCount).filter((citations) => citations.length > 0),
        }),
        { maxLength: 2 },
      );

const keyFindingArb = (sourceCount: number): fc.Arbitrary<KeyFinding> =>
  fc
    .record({
      text: textArb(1),
      citations: citationsArb(sourceCount),
      editorialBias: fc.boolean(),
      facet: fc.option(fc.dictionary(textArb(1), facetScalarArb, { maxKeys: 3 }), { nil: null }),
      children: childFindingsArb(sourceCount),
    })
    .map(({ text, citations, editorialBias, facet, children }) => ({
      text,
      citations,
      // Uncited findings are only legal when editorial — keep samples valid.
      editorial: citations.length === 0 ? true : editorialBias,
      facet,
      children,
    }));

const sectionArb = (sourceCount: number): fc.Arbitrary<Section> =>
  fc.record({
    heading: textArb(1),
    body_md: textArb(0),
    citations: citationsArb(sourceCount),
  });

const sourceAtIndexArb = (index: number): fc.Arbitrary<BriefSource> =>
  fc
    .record({
      withFinalUrl: fc.boolean(),
      title: fc.option(textArb(1), { nil: null }),
      fetched_at: isoDateArb,
      published_at: fc.option(isoDateArb, { nil: null }),
    })
    .map(({ withFinalUrl, title, fetched_at, published_at }) => ({
      n: index + 1,
      // Index-derived URLs guarantee normalized-URL uniqueness across sources.
      url: `https://source-${index}.example.com/page`,
      final_url: withFinalUrl ? `https://source-${index}.example.com/landing` : null,
      host: `source-${index}.example.com`,
      title,
      fetched_at,
      published_at,
    }));

const sourcesArb = (sourceCount: number): fc.Arbitrary<BriefSource[]> =>
  sourceCount === 0
    ? fc.constant([])
    : fc
        .tuple(...Array.from({ length: sourceCount }, (_, index) => sourceAtIndexArb(index)))
        .map((sources) => [...sources]);

const comparisonArb: fc.Arbitrary<BriefFacets> = fc
  .integer({ min: 1, max: 3 })
  .chain((width) =>
    fc.record({
      columns: fc.array(textArb(1), { minLength: width, maxLength: width }),
      rows: fc.array(fc.array(facetScalarArb, { minLength: width, maxLength: width }), {
        maxLength: 3,
      }),
    }),
  )
  .map((comparison) => ({ comparison }));

const facetsArb: fc.Arbitrary<Brief['facets']> = fc.option(
  fc.oneof(fc.constant<BriefFacets>({ comparison: null }), comparisonArb),
  { nil: null },
);

const metadataArb: fc.Arbitrary<BriefMetadata> = fc.record({
  search_provider: fc.option(fc.constantFrom('tavily', 'brave', 'google', 'duckduckgo'), {
    nil: null,
  }),
  synthesis: fc.constantFrom<BriefMetadata['synthesis']>('deterministic', 'llm'),
  deterministic_fallback_used: fc.boolean(),
  coverage: fc.option(fc.double({ min: 0, max: 1, noNaN: true }), { nil: null }),
  freshness: fc.option(textArb(1), { nil: null }),
  citation_verdict: fc.option(
    fc.record({
      claims_checked: fc.nat({ max: 50 }),
      flagged: fc.nat({ max: 10 }),
      stripped: fc.nat({ max: 10 }),
    }),
    { nil: null },
  ),
  usage: fc.option(
    fc.record({
      input_tokens: fc.nat({ max: 200000 }),
      output_tokens: fc.nat({ max: 200000 }),
      cost_usd: fc.double({ min: 0, max: 25, noNaN: true }),
    }),
    { nil: null },
  ),
  run_id: fc.option(ulidArb, { nil: null }),
});

const noticeArb: fc.Arbitrary<BriefNotice> = fc.record({
  source: textArb(0),
  reason: textArb(1),
  kind: fc.constantFrom<BriefNotice['kind']>(
    'fetch_failed',
    'extract_failed',
    'blocked',
    'source_excluded',
    'uncited_claim_stripped',
    'uncited_claim_flagged',
    'budget_exhausted',
    'limited_evidence',
    'other',
  ),
});

export interface ValidBriefArbConstraints {
  /** Minimum number of sources; default 0. */
  readonly minSources?: number;
  /** Minimum number of key findings; default 0. */
  readonly minKeyFindings?: number;
}

/**
 * Generates structurally consistent Brief documents: contiguous source
 * numbering from 1, citations drawn only from declared sources, editorial
 * markers on uncited findings, matching comparison row/column arity, and
 * no ANSI escapes. Every sample must pass `validateBrief`.
 */
export const validBriefArb = (constraints: ValidBriefArbConstraints = {}): fc.Arbitrary<Brief> => {
  const minSources = constraints.minSources ?? 0;
  const minKeyFindings = constraints.minKeyFindings ?? 0;

  return fc.integer({ min: minSources, max: Math.max(minSources, 5) }).chain((sourceCount) =>
    fc
      .record({
        brief_id: ulidArb,
        task_id: ulidArb,
        title: textArb(1),
        overview: textArb(0),
        key_findings: fc.array(keyFindingArb(sourceCount), {
          minLength: minKeyFindings,
          maxLength: 4,
        }),
        sections: fc.array(sectionArb(sourceCount), { maxLength: 3 }),
        facets: facetsArb,
        sources: sourcesArb(sourceCount),
        metadata: metadataArb,
        notices: fc.array(noticeArb, { maxLength: 3 }),
      })
      .map((brief) => ({ ...brief, schema_version: '0.2' as const })),
  );
};

export type BriefCorruption =
  | 'dangling_citation'
  | 'duplicate_url'
  | 'numbering_gap'
  | 'ansi_injection'
  | 'uncited_finding';

export const BRIEF_CORRUPTIONS: readonly BriefCorruption[] = [
  'dangling_citation',
  'duplicate_url',
  'numbering_gap',
  'ansi_injection',
  'uncited_finding',
];

const applyCorruption = (brief: Brief, corruption: BriefCorruption): Brief => {
  switch (corruption) {
    case 'dangling_citation': {
      const [first, ...rest] = brief.key_findings;
      return {
        ...brief,
        key_findings: [
          { ...first!, citations: [...first!.citations, brief.sources.length + 1] },
          ...rest,
        ],
      };
    }
    case 'duplicate_url': {
      const original = brief.sources[0]!;
      return {
        ...brief,
        sources: [...brief.sources, { ...original, n: brief.sources.length + 1 }],
      };
    }
    case 'numbering_gap': {
      const lastIndex = brief.sources.length - 1;
      return {
        ...brief,
        sources: brief.sources.map((source, index) =>
          index === lastIndex ? { ...source, n: source.n + 1 } : source,
        ),
      };
    }
    case 'ansi_injection':
      return { ...brief, overview: `${ESC}[31m${brief.overview}` };
    case 'uncited_finding': {
      const [first, ...rest] = brief.key_findings;
      return {
        ...brief,
        key_findings: [{ ...first!, citations: [], editorial: false }, ...rest],
      };
    }
  }
};

export interface MutatedBrief {
  /** The corrupted document — guaranteed to violate exactly the named rule. */
  readonly brief: Brief;
  /** Which corruption was applied. */
  readonly corruption: BriefCorruption;
}

/**
 * Generates a valid Brief (at least one source and one key finding, so
 * every corruption has something to break) and applies one random
 * corruption. The validator must reject every sample.
 */
export const mutatedBriefArb: fc.Arbitrary<MutatedBrief> = fc
  .tuple(validBriefArb({ minSources: 1, minKeyFindings: 1 }), fc.constantFrom(...BRIEF_CORRUPTIONS))
  .map(([brief, corruption]) => ({ brief: applyCorruption(brief, corruption), corruption }));
