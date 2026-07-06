import { BriefSource } from '@yantra/protocol';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { CLUSTER_SIMILARITY_THRESHOLD, clusterSources } from '../../src/synthesis/clustering.js';
import { cosineSimilarity, tfidfVectors, tokenize } from '../../src/synthesis/similarity.js';
import type { SynthesisDoc } from '../../src/synthesis/types.js';

const SYNDICATED_ARTICLE =
  'The city council approved the new transit budget on Tuesday. ' +
  'The plan allocates 45 million dollars to bus rapid transit over three years. ' +
  'Advocates said the expansion will cut average commute times by 15 minutes. ' +
  'Opponents argued the money should go to road maintenance instead.';

const UNRELATED_ARTICLE =
  'Researchers published a study on deep sea coral bleaching this month. ' +
  'Warmer currents have damaged reefs at depths previously thought safe. ' +
  'The team used submersible drones to map the affected regions in detail.';

const THIRD_ARTICLE =
  'A local bakery won the national sourdough championship this weekend. ' +
  'Judges praised the crust texture and the balance of acidity in the crumb. ' +
  'The owner plans to open a second location downtown next spring.';

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

describe('@no-llm synthesis/similarity', () => {
  it('tokenizes with lowercasing, punctuation stripping, and stopword removal', () => {
    expect(tokenize('The Council APPROVED the plan!')).toEqual(['council', 'approved', 'plan']);
  });

  it('keeps multi-byte scripts intact when tokenizing', () => {
    expect(tokenize('価格は 12000 円です')).toEqual(['価格は', '12000', '円です']);
  });

  it('scores identical documents at similarity 1', () => {
    const [left, right] = tfidfVectors([SYNDICATED_ARTICLE, SYNDICATED_ARTICLE]);
    expect(cosineSimilarity(left!, right!)).toBeCloseTo(1, 5);
  });

  it('scores unrelated documents below the clustering threshold', () => {
    const [left, right] = tfidfVectors([SYNDICATED_ARTICLE, UNRELATED_ARTICLE]);
    expect(cosineSimilarity(left!, right!)).toBeLessThan(CLUSTER_SIMILARITY_THRESHOLD);
  });

  it('returns 0 for empty documents', () => {
    const [left, right] = tfidfVectors(['', SYNDICATED_ARTICLE]);
    expect(cosineSimilarity(left!, right!)).toBe(0);
  });
});

describe('@no-llm synthesis/clustering', () => {
  it('returns the empty result for an empty doc set', () => {
    expect(clusterSources([])).toEqual({ clusters: [], sources: [], clusterNumberByDoc: [] });
  });

  it('yields a single singleton cluster for one doc', () => {
    const result = clusterSources([doc({ url: 'https://a.example.com/1', text: THIRD_ARTICLE })]);

    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0]).toMatchObject({ representative: 0, members: [0] });
    expect(result.sources.map((source) => source.n)).toEqual([1]);
    expect(result.clusterNumberByDoc).toEqual([1]);
  });

  it('clusters identical docs and keeps unrelated docs apart', () => {
    const result = clusterSources([
      doc({ url: 'https://a.example.com/1', text: SYNDICATED_ARTICLE }),
      doc({ url: 'https://b.example.com/1', text: UNRELATED_ARTICLE }),
      doc({ url: 'https://c.example.com/1', text: SYNDICATED_ARTICLE }),
    ]);

    expect(result.clusters).toHaveLength(2);
    expect(result.clusterNumberByDoc[0]).toBe(result.clusterNumberByDoc[2]);
    expect(result.clusterNumberByDoc[1]).not.toBe(result.clusterNumberByDoc[0]);
  });

  it('represents a syndicated copy by its higher-ranked host', () => {
    const result = clusterSources([
      doc({ url: 'https://original.example.com/story', text: SYNDICATED_ARTICLE }),
      doc({
        url: 'https://mirror.example.net/reprint',
        text: `${SYNDICATED_ARTICLE} Reprinted with permission.`,
      }),
    ]);

    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0]!.representative).toBe(0);
    expect(result.clusters[0]!.members).toEqual([0, 1]);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]!.host).toBe('original.example.com');
  });

  it('always merges docs sharing a normalized URL, regardless of text drift', () => {
    const result = clusterSources([
      doc({ url: 'https://a.example.com/page', text: SYNDICATED_ARTICLE }),
      doc({
        url: 'https://a.example.com/page?utm=x',
        finalUrl: 'https://a.example.com/page',
        text: UNRELATED_ARTICLE,
      }),
    ]);

    expect(result.clusters).toHaveLength(1);
    expect(result.sources).toHaveLength(1);
  });

  it('numbers sources contiguously in representative rank order and emits schema-valid sources', () => {
    const result = clusterSources([
      doc({ url: 'https://z.example.com/1', text: THIRD_ARTICLE }),
      doc({ url: 'https://y.example.com/1', text: UNRELATED_ARTICLE }),
      doc({ url: 'https://x.example.com/1', text: SYNDICATED_ARTICLE }),
      doc({ url: 'https://w.example.com/1', text: SYNDICATED_ARTICLE }),
    ]);

    expect(result.sources.map((source) => source.n)).toEqual([1, 2, 3]);
    expect(result.sources[0]!.host).toBe('z.example.com');
    expect(result.sources[1]!.host).toBe('y.example.com');
    expect(result.sources[2]!.host).toBe('x.example.com');

    for (const source of result.sources) {
      expect(BriefSource.safeParse(source).success).toBe(true);
    }
  });

  it('assigns every doc to exactly one cluster number', () => {
    const result = clusterSources([
      doc({ url: 'https://a.example.com/1', text: SYNDICATED_ARTICLE }),
      doc({ url: 'https://b.example.com/1', text: UNRELATED_ARTICLE }),
      doc({ url: 'https://c.example.com/1', text: THIRD_ARTICLE }),
    ]);

    for (const n of result.clusterNumberByDoc) {
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(result.sources.length);
    }
  });

  it('produces cluster membership invariant under shuffled input order (property)', () => {
    const corpusArb = fc
      .array(fc.constantFrom(SYNDICATED_ARTICLE, UNRELATED_ARTICLE, THIRD_ARTICLE), {
        minLength: 2,
        maxLength: 6,
      })
      .map((texts) =>
        texts.map((text, index) => doc({ url: `https://host-${index}.example.com/p`, text })),
      );

    const membershipByUrl = (docs: readonly SynthesisDoc[]): string => {
      const result = clusterSources(docs);
      const groups = result.clusters.map((cluster) =>
        cluster.members
          .map((member) => docs[member]!.url)
          .sort()
          .join('|'),
      );
      return groups.sort().join('||');
    };

    fc.assert(
      fc.property(
        corpusArb.chain((docs) =>
          fc.tuple(fc.constant(docs), fc.shuffledSubarray(docs, { minLength: docs.length })),
        ),
        ([original, shuffled]) => {
          expect(membershipByUrl(shuffled)).toBe(membershipByUrl(original));
        },
      ),
      { numRuns: 100 },
    );
  });
});
