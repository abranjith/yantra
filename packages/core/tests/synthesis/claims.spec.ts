import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { extractClaims, splitSentences } from '../../src/synthesis/claims.js';
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

describe('@no-llm synthesis/splitSentences', () => {
  it('splits prose into trimmed sentences in document order', () => {
    const sentences = splitSentences('First point. Second point! Third point?');
    expect(sentences).toEqual(['First point.', 'Second point!', 'Third point?']);
  });

  it('returns an empty array for empty text', () => {
    expect(splitSentences('')).toEqual([]);
  });
});

describe('@no-llm synthesis/extractClaims', () => {
  it('extracts a price sentence with the number kind', () => {
    const claims = extractClaims(priceCorpus.docs, priceCorpus.query);

    const priceClaim = claims.find((claim) => claim.text.includes('$328'));
    expect(priceClaim).toBeDefined();
    expect(priceClaim!.kind).toBe('number');
    expect(priceClaim!.docIndexes).toContain(0);
  });

  it('ranks a claim supported by three docs above a single-doc claim', () => {
    const shared =
      'The city council approved a forty five million dollar transit budget for the region on Tuesday.';
    const unique =
      'A neighborhood bakery introduced a seasonal pastry menu with rotating weekly specials this month.';

    const claims = extractClaims(
      [
        doc({
          url: 'https://a.example.com/1',
          text: `${shared} Local reporters covered the vote.`,
        }),
        doc({ url: 'https://b.example.com/1', text: `${shared} Coverage continued all week.` }),
        doc({ url: 'https://c.example.com/1', text: `${shared} Officials praised the outcome.` }),
        doc({
          url: 'https://d.example.com/1',
          text: `${unique} Regulars lined up before opening.`,
        }),
      ],
      'transit budget',
    );

    const sharedClaim = claims.find((claim) => claim.text === shared);
    const uniqueClaim = claims.find((claim) => claim.text === unique);

    expect(sharedClaim).toBeDefined();
    expect(uniqueClaim).toBeDefined();
    expect(sharedClaim!.docIndexes).toEqual([0, 1, 2]);
    expect(sharedClaim!.salience).toBeGreaterThan(uniqueClaim!.salience);
    expect(claims.indexOf(sharedClaim!)).toBeLessThan(claims.indexOf(uniqueClaim!));
  });

  it('boosts claims that overlap the query terms', () => {
    const first = 'The museum extended its evening opening hours for the summer season program.';
    const second =
      'Admission prices for students were reduced across every weekday afternoon slot.';

    const claims = extractClaims(
      [doc({ url: 'https://a.example.com/1', text: `${first} ${second}` })],
      'student admission prices',
    );

    const firstClaim = claims.find((claim) => claim.text === first);
    const secondClaim = claims.find((claim) => claim.text === second);

    expect(firstClaim).toBeDefined();
    expect(secondClaim).toBeDefined();
    // Despite its later position, the query-matching sentence ranks first.
    expect(secondClaim!.salience).toBeGreaterThan(firstClaim!.salience);
  });

  it('always carries at least one evidence docIndex per claim', () => {
    const claims = extractClaims(priceCorpus.docs, priceCorpus.query);

    expect(claims.length).toBeGreaterThan(0);
    for (const claim of claims) {
      expect(claim.docIndexes.length).toBeGreaterThanOrEqual(1);
      for (const index of claim.docIndexes) {
        expect(index).toBeGreaterThanOrEqual(0);
        expect(index).toBeLessThan(priceCorpus.docs.length);
      }
    }
  });

  it('extracts entity claims for names repeated across two docs', () => {
    const claims = extractClaims(
      [
        doc({
          url: 'https://a.example.com/1',
          text: 'Metro Transit Authority officials confirmed the schedule change would begin next month.',
        }),
        doc({
          url: 'https://b.example.com/1',
          text: 'Riders questioned Metro Transit Authority leadership about accessibility at the open forum.',
        }),
      ],
      'transit schedule',
    );

    const entityClaim = claims.find((claim) => claim.kind === 'entity');
    expect(entityClaim).toBeDefined();
    expect(entityClaim!.text).toContain('Metro Transit Authority');
    expect(entityClaim!.docIndexes.length).toBeGreaterThanOrEqual(1);
  });

  it('is safe on UTF-8 multi-byte text and preserves the characters intact', () => {
    const mixed =
      'Sony ヘッドホン costs $120 in Tokyo stores this week, according to local retailers.';

    const claims = extractClaims(
      [doc({ url: 'https://jp.example.com/1', text: `${mixed} 店舗は週末も営業しています。` })],
      'sony headphones tokyo price',
    );

    const claim = claims.find((entry) => entry.text.includes('ヘッドホン'));
    expect(claim).toBeDefined();
    expect(claim!.kind).toBe('number');
    expect(claim!.text).toContain('ヘッドホン');
  });

  it('returns an empty list for an empty doc set', () => {
    expect(extractClaims([], 'anything')).toEqual([]);
  });
});
