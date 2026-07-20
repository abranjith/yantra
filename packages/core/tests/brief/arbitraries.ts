/**
 * fast-check arbitraries for Brief render tests (FEAT-015).
 *
 * `briefArb()` generates structurally consistent, schema-valid Briefs
 * (contiguous source numbering, citations drawn only from declared sources,
 * editorial marks on uncited findings, matching comparison arity). Every
 * sample must pass `validateBrief`.
 *
 * In `{ dangerous: true }` mode every string field — and some source URLs —
 * is drawn from a pool that mixes benign text with XSS vectors
 * (`<script>`, `onerror=`, `javascript:` / `data:` URLs). These stay
 * schema-valid (the Brief schema forbids only ANSI, not HTML), which lets the
 * HTML-inertness property test (TASK-003) assert that no executable vector
 * survives into the rendered `brief.html`.
 */

import type {
  Brief,
  BriefFacets,
  BriefMetadata,
  BriefNotice,
  BriefSource,
  KeyFinding,
  Section,
} from '@yantra/protocol';
import fc from 'fast-check';

/** ESC (0x1B) / CSI (0x9B) bytes, built via char code to keep this file ANSI-free. */
const ESC = String.fromCharCode(0x1b);
const CSI = String.fromCharCode(0x9b);
const containsAnsi = (value: string): boolean => value.includes(ESC) || value.includes(CSI);

/** Executable-vector payloads injected into every string field in dangerous mode. */
export const XSS_PAYLOADS: readonly string[] = [
  '<script>alert(1)</script>',
  '"><script>alert(2)</script>',
  '<img src=x onerror=alert(3)>',
  '<svg/onload=alert(4)>',
  '</title><script>alert(5)</script>',
  '<iframe src="data:text/html,<script>alert(6)</script>"></iframe>',
  '<a href="javascript:alert(7)">x</a>',
  'javascript:void(0)\'"<>&',
];

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ulidArb: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...CROCKFORD.split('')), { minLength: 26, maxLength: 26 })
  .map((chars) => chars.join(''));

const benignText = (minLength: number): fc.Arbitrary<string> =>
  fc.string({ minLength: Math.max(minLength, 1), maxLength: 40 }).filter((v) => !containsAnsi(v));

const textArb = (minLength: number, dangerous: boolean): fc.Arbitrary<string> => {
  if (!dangerous) {
    return benignText(minLength);
  }
  return fc.oneof(
    benignText(minLength),
    fc.constantFrom(...XSS_PAYLOADS),
    fc
      .tuple(benignText(minLength), fc.constantFrom(...XSS_PAYLOADS))
      .map(([lead, payload]) => `${lead} ${payload}`),
  );
};

const isoDateArb: fc.Arbitrary<string> = fc
  .date({
    min: new Date('2020-01-01T00:00:00.000Z'),
    max: new Date('2030-12-31T23:59:59.000Z'),
    noInvalidDate: true,
  })
  .map((date) => date.toISOString());

const facetScalarArb = (dangerous: boolean): fc.Arbitrary<string | number | boolean | null> =>
  fc.oneof(textArb(0, dangerous), fc.integer(), fc.boolean(), fc.constant(null));

const citationsArb = (sourceCount: number): fc.Arbitrary<number[]> =>
  sourceCount === 0
    ? fc.constant([])
    : fc.array(fc.integer({ min: 1, max: sourceCount }), { maxLength: 4 });

const keyFindingArb = (sourceCount: number, dangerous: boolean): fc.Arbitrary<KeyFinding> =>
  fc
    .record({
      text: textArb(1, dangerous),
      citations: citationsArb(sourceCount),
      editorialBias: fc.boolean(),
      facet: fc.option(fc.dictionary(benignText(1), facetScalarArb(dangerous), { maxKeys: 3 }), {
        nil: null,
      }),
    })
    .map(({ text, citations, editorialBias, facet }) => ({
      text,
      citations,
      // Uncited findings are only legal when editorial — keep every sample valid.
      editorial: citations.length === 0 ? true : editorialBias,
      facet,
    }));

const sectionArb = (sourceCount: number, dangerous: boolean): fc.Arbitrary<Section> =>
  fc.record({
    heading: textArb(1, dangerous),
    body_md: textArb(0, dangerous),
    citations: citationsArb(sourceCount),
  });

const sourceUrlArb = (index: number, dangerous: boolean): fc.Arbitrary<string> =>
  dangerous
    ? fc.constantFrom(
        `https://source-${index}.example.com/page`,
        `javascript:alert(${index})`,
        `data:text/html,<script>alert(${index})</script>`,
      )
    : fc.constant(`https://source-${index}.example.com/page`);

const sourceAtIndexArb = (index: number, dangerous: boolean): fc.Arbitrary<BriefSource> =>
  fc
    .record({
      url: sourceUrlArb(index, dangerous),
      title: fc.option(textArb(1, dangerous), { nil: null }),
      excerpt: fc.option(textArb(1, dangerous), { nil: null }),
      fetched_at: isoDateArb,
      published_at: fc.option(isoDateArb, { nil: null }),
    })
    .map(({ url, title, excerpt, fetched_at, published_at }) => ({
      n: index + 1,
      url,
      // final_url stays null so the normalized-URL uniqueness key is just `url`,
      // which is index-unique by construction.
      final_url: null,
      host: `source-${index}.example.com`,
      title,
      excerpt,
      fetched_at,
      published_at,
    }));

const sourcesArb = (sourceCount: number, dangerous: boolean): fc.Arbitrary<BriefSource[]> =>
  sourceCount === 0
    ? fc.constant([])
    : fc
        .tuple(
          ...Array.from({ length: sourceCount }, (_, index) => sourceAtIndexArb(index, dangerous)),
        )
        .map((sources) => [...sources]);

const facetsArb = (dangerous: boolean): fc.Arbitrary<Brief['facets']> =>
  fc.option(
    fc.oneof(
      fc.constant<BriefFacets>({ comparison: null }),
      fc.integer({ min: 1, max: 3 }).chain((width) =>
        fc
          .record({
            columns: fc.array(textArb(1, dangerous), { minLength: width, maxLength: width }),
            rows: fc.array(
              fc.array(facetScalarArb(dangerous), { minLength: width, maxLength: width }),
              { maxLength: 3 },
            ),
          })
          .map((comparison) => ({ comparison })),
      ),
    ),
    { nil: null },
  );

const metadataArb: fc.Arbitrary<BriefMetadata> = fc.record({
  search_provider: fc.option(fc.constantFrom('tavily', 'brave', 'google', 'duckduckgo'), {
    nil: null,
  }),
  synthesis: fc.constantFrom<BriefMetadata['synthesis']>('deterministic', 'llm'),
  deterministic_fallback_used: fc.boolean(),
  coverage: fc.option(fc.double({ min: 0, max: 1, noNaN: true }), { nil: null }),
  freshness: fc.option(benignText(1), { nil: null }),
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

const noticeArb = (dangerous: boolean): fc.Arbitrary<BriefNotice> =>
  fc.record({
    source: textArb(0, dangerous),
    reason: textArb(1, dangerous),
    kind: fc.constantFrom<BriefNotice['kind']>(
      'fetch_failed',
      'extract_failed',
      'blocked',
      'uncited_claim_stripped',
      'uncited_claim_flagged',
      'budget_exhausted',
      'other',
    ),
  });

/** Options for {@link briefArb}. */
export interface BriefArbOptions {
  /** Inject XSS/ANSI-safe-but-HTML-dangerous payloads into string fields. */
  readonly dangerous?: boolean;
  /** Minimum number of sources; default 0. */
  readonly minSources?: number;
}

/**
 * Generates schema-valid Brief documents for renderer property tests.
 *
 * @param options - `dangerous` injects XSS vectors; `minSources` floors the
 *   source count (use ≥1 when the property needs at least one citation).
 */
export const briefArb = (options: BriefArbOptions = {}): fc.Arbitrary<Brief> => {
  const dangerous = options.dangerous ?? false;
  const minSources = options.minSources ?? 0;

  return fc.integer({ min: minSources, max: Math.max(minSources, 5) }).chain((sourceCount) =>
    fc
      .record({
        brief_id: ulidArb,
        task_id: ulidArb,
        title: textArb(1, dangerous),
        overview: textArb(0, dangerous),
        key_findings: fc.array(keyFindingArb(sourceCount, dangerous), { maxLength: 4 }),
        sections: fc.array(sectionArb(sourceCount, dangerous), { maxLength: 3 }),
        facets: facetsArb(dangerous),
        sources: sourcesArb(sourceCount, dangerous),
        metadata: metadataArb,
        notices: fc.array(noticeArb(dangerous), { maxLength: 3 }),
      })
      .map((brief) => ({ ...brief, schema_version: '0.2' as const })),
  );
};
