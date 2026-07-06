/**
 * fast-check arbitraries for synthesis corpora.
 *
 * Shared across the deterministic-synthesizer property suite (TASK-004) and
 * the citation-faithfulness property suite (TASK-006): both need randomized
 * but realistic `SynthesisInput`s (ranked docs + optional per-source
 * failures) to assert the invariants the deterministic path must always hold
 * (schema-valid output, zero citation flags).
 */

import fc from 'fast-check';

import type { SourceFailure, SynthesisDoc, SynthesisInput } from '../../src/synthesis/types.js';

/** Sentence fragments assembled into plausible article prose. */
const SUBJECTS = [
  'The city council',
  'Local retailers',
  'The research team',
  'Analysts',
  'The transit authority',
  'Company executives',
];

const PREDICATES = [
  'approved a new budget of $45 million',
  'reported prices rising by 4% this week',
  'confirmed the change would take effect in 2026',
  'said adoption is accelerating across the region',
  'announced 12000 new units shipped',
  'noted stock levels remain healthy',
];

const sentenceArb: fc.Arbitrary<string> = fc
  .tuple(fc.constantFrom(...SUBJECTS), fc.constantFrom(...PREDICATES))
  .map(([subject, predicate]) => `${subject} ${predicate}.`);

const docTextArb: fc.Arbitrary<string> = fc
  .array(sentenceArb, { minLength: 2, maxLength: 6 })
  .map((sentences) => sentences.join(' '));

const isoDateArb: fc.Arbitrary<string> = fc
  .date({
    min: new Date('2024-01-01T00:00:00.000Z'),
    max: new Date('2026-12-31T23:59:59.000Z'),
    noInvalidDate: true,
  })
  .map((date) => date.toISOString());

const docAtIndexArb = (index: number): fc.Arbitrary<SynthesisDoc> =>
  fc
    .record({
      text: docTextArb,
      title: fc.option(fc.constantFrom('Report', 'Update', 'Analysis', 'Roundup'), { nil: null }),
      fetchedAt: isoDateArb,
      publishedAt: fc.option(isoDateArb, { nil: null }),
      excerpt: fc.option(fc.string({ minLength: 0, maxLength: 40 }), { nil: null }),
    })
    .map(({ text, title, fetchedAt, publishedAt, excerpt }) => ({
      url: `https://source-${index}.example.com/article`,
      finalUrl: null,
      host: `source-${index}.example.com`,
      title,
      fetchedAt,
      publishedAt,
      text,
      excerpt,
    }));

const failureArb: fc.Arbitrary<SourceFailure> = fc
  .record({
    index: fc.integer({ min: 0, max: 99 }),
    stage: fc.constantFrom<SourceFailure['stage']>('fetch', 'extract', 'blocked'),
    reason: fc.constantFrom('timed out', 'connection refused', 'robots.txt disallow'),
  })
  .map(({ index, stage, reason }) => ({
    url: `https://failed-${index}.example.com/x`,
    host: `failed-${index}.example.com`,
    stage,
    reason,
  }));

/** Constraints for {@link synthesisInputArb}. */
export interface SynthesisCorpusConstraints {
  /** Minimum number of successfully extracted docs; default 0. */
  readonly minDocs?: number;
  /** Maximum number of successfully extracted docs; default 5. */
  readonly maxDocs?: number;
  /** Maximum number of per-source failures; default 2. */
  readonly maxFailures?: number;
}

/**
 * Generates a `SynthesisInput`: a query plus rank-ordered docs and optional
 * failures. Docs get distinct hosts/URLs so clustering treats them as
 * independent unless their text coincides.
 */
export const synthesisInputArb = (
  constraints: SynthesisCorpusConstraints = {},
): fc.Arbitrary<SynthesisInput> => {
  const minDocs = constraints.minDocs ?? 0;
  const maxDocs = Math.max(minDocs, constraints.maxDocs ?? 5);
  const maxFailures = constraints.maxFailures ?? 2;

  return fc
    .integer({ min: minDocs, max: maxDocs })
    .chain((docCount) =>
      fc.record({
        query: fc.constantFrom(
          'city transit budget',
          'headphone prices today',
          'enterprise adoption trends',
          'shipping update',
        ),
        docs:
          docCount === 0
            ? fc.constant<SynthesisDoc[]>([])
            : fc
                .tuple(...Array.from({ length: docCount }, (_, i) => docAtIndexArb(i)))
                .map((docs) => [...docs]),
        failures: fc.array(failureArb, { maxLength: maxFailures }),
      }),
    )
    .map((input) => ({ ...input }));
};
