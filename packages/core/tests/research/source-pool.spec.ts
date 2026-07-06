import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { DEFAULT_PER_HOST_CAP, SourcePool, normalizeUrl } from '../../src/research/source-pool.js';
import type { SynthesisDoc } from '../../src/synthesis/types.js';

/**
 * Distinct filler sentences so unrelated docs never trip the near-dup gate.
 * The seed is woven *into* content words (`metricstory`, `factorstory`) so
 * distinct seeds share no informative tokens even when the seed itself is a
 * single character (bare 1-char tokens are dropped by the tokenizer).
 */
function bodyFor(seed: string): string {
  const s = seed.replace(/[^a-z0-9]/gi, '');
  return `Findings item${s}: the metric${s} and factor${s} describe outcome${s}. Context${s} and region${s} frame result${s} in a way unique to record${s}.`;
}

function makeDoc(overrides: Partial<SynthesisDoc> & { url: string }): SynthesisDoc {
  const host = overrides.host ?? new URL(overrides.url).hostname;
  return {
    url: overrides.url,
    finalUrl: overrides.finalUrl ?? null,
    host,
    title: overrides.title ?? 'Title',
    fetchedAt: '2026-05-11T10:00:00.000Z',
    publishedAt: null,
    text: overrides.text ?? bodyFor(overrides.url),
    excerpt: null,
  };
}

describe('@no-llm research/source-pool normalizeUrl', () => {
  it.each([
    ['https://a.com/x/?utm_source=n#frag', 'https://a.com/x'],
    ['https://A.com/x', 'https://a.com/x'],
    ['https://a.com/x/', 'https://a.com/x'],
    ['https://a.com/', 'https://a.com/'],
    ['https://a.com/x?q=1&utm_medium=e', 'https://a.com/x?q=1'],
    ['https://a.com/x?gclid=z', 'https://a.com/x'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeUrl(input)).toBe(expected);
  });

  it('falls back to a trimmed lowercase string for an unparseable URL', () => {
    expect(normalizeUrl('  NOT a url ')).toBe('not a url');
  });
});

describe('@no-llm research/source-pool dedup + diversification', () => {
  it('dedups the same article reached via two URLs (tracking params differ)', () => {
    const pool = new SourcePool({ maxSources: 10 });

    const first = pool.add(makeDoc({ url: 'https://a.com/story', text: bodyFor('story') }), 0);
    const second = pool.add(
      makeDoc({ url: 'https://a.com/story?utm_source=news', text: bodyFor('story') }),
      1,
    );

    expect(first.kept).toBe(true);
    expect(second).toEqual({ kept: false, rejection: 'duplicate_url' });
    expect(pool.size()).toBe(1);
  });

  it('rejects a near-duplicate (identical body on a different host)', () => {
    const pool = new SourcePool({ maxSources: 10 });
    const body = bodyFor('syndicated');

    pool.add(makeDoc({ url: 'https://a.com/x', text: body }), 0);
    const dup = pool.add(makeDoc({ url: 'https://b.com/y', text: body }), 1);

    expect(dup).toEqual({ kept: false, rejection: 'near_duplicate' });
    expect(pool.size()).toBe(1);
  });

  it('keeps only the best-ranked docs per host (6 from one host -> 3 kept)', () => {
    const pool = new SourcePool({ maxSources: 100 });

    // Insert in shuffled rank order to prove rank-preferential eviction.
    for (const rank of [3, 0, 5, 1, 4, 2]) {
      pool.add(makeDoc({ url: `https://one.com/a${rank}`, text: bodyFor(`a${rank}`) }), rank);
    }

    expect(pool.size()).toBe(DEFAULT_PER_HOST_CAP);
    const keptUrls = pool.docs().map((doc) => doc.url);
    expect(keptUrls).toEqual(['https://one.com/a0', 'https://one.com/a1', 'https://one.com/a2']);
  });

  it('enforces maxSources across hosts', () => {
    const pool = new SourcePool({ maxSources: 2 });

    expect(pool.add(makeDoc({ url: 'https://a.com/1', text: bodyFor('1') }), 0).kept).toBe(true);
    expect(pool.add(makeDoc({ url: 'https://b.com/2', text: bodyFor('2') }), 1).kept).toBe(true);
    const third = pool.add(makeDoc({ url: 'https://c.com/3', text: bodyFor('3') }), 2);

    expect(third).toEqual({ kept: false, rejection: 'max_sources' });
    expect(pool.isFull()).toBe(true);
    expect(pool.size()).toBe(2);
  });

  it('builds a SynthesisInput from the kept docs in rank order', () => {
    const pool = new SourcePool({ maxSources: 10 });
    pool.add(makeDoc({ url: 'https://a.com/2', text: bodyFor('2') }), 2);
    pool.add(makeDoc({ url: 'https://b.com/0', text: bodyFor('0') }), 0);

    const input = pool.toSynthesisInput('topic', []);
    expect(input.query).toBe('topic');
    expect(input.docs.map((doc) => doc.url)).toEqual(['https://b.com/0', 'https://a.com/2']);
  });
});

describe('@no-llm research/source-pool property', () => {
  it('never exceeds maxSources nor the per-host cap under random inserts', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 8 }),
        fc.integer({ min: 1, max: 4 }),
        fc.array(
          fc.record({
            host: fc.constantFrom('a.com', 'b.com', 'c.com', 'd.com'),
            path: fc.integer({ min: 0, max: 200 }),
            rank: fc.integer({ min: 0, max: 200 }),
          }),
          { maxLength: 60 },
        ),
        (maxSources, perHostCap, inserts) => {
          const pool = new SourcePool({ maxSources, perHostCap });
          for (const insert of inserts) {
            const url = `https://${insert.host}/p${insert.path}`;
            pool.add(
              makeDoc({ url, host: insert.host, text: bodyFor(`${insert.host}-${insert.path}`) }),
              insert.rank,
            );
          }

          expect(pool.size()).toBeLessThanOrEqual(maxSources);
          const perHost = new Map<string, number>();
          for (const doc of pool.docs()) {
            perHost.set(doc.host, (perHost.get(doc.host) ?? 0) + 1);
          }
          for (const count of perHost.values()) {
            expect(count).toBeLessThanOrEqual(perHostCap);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
