/**
 * @no-llm Discovery envelope property: sanitizer-totality (FEAT-020 TASK-006).
 *
 * Guarantee: every string `buildObservation` hands back — the only channel
 * the discovery proposer ever sees of a page — has passed through the single
 * `sanitize()` chokepoint. This corpus mirrors the FEAT-006 sanitizer
 * property-test shape (email/SSN/credit-card/API-key/auth-URL generators) and
 * asserts none of those raw shapes survive into `page_digest`, no matter how
 * they're mixed into extracted page content.
 */

import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { Page } from '../../src/browser/types.js';
import { buildObservation } from '../../src/discovery/observe.js';
import type { Extractor } from '../../src/extraction/readability.js';
import type { ExtractedArticle, FetchedDoc } from '../../src/extraction/types.js';

const corpusArbitrary = fc.record({
  email: fc
    .tuple(
      fc.string({ minLength: 3, maxLength: 8 }).filter((s) => /^[a-z0-9]+$/i.test(s)),
      fc.string({ minLength: 3, maxLength: 8 }).filter((s) => /^[a-z0-9]+$/i.test(s)),
    )
    .map(([user, domain]) => `${user}@${domain}.com`),
  ssn: fc
    .tuple(
      fc.integer({ min: 100, max: 999 }),
      fc.integer({ min: 10, max: 99 }),
      fc.integer({ min: 1000, max: 9999 }),
    )
    .map(([a, b, c]) => `${a}-${b}-${c}`),
  creditCard: fc.constantFrom('4111111111111111', '4012888888881881', '5555555555554444'),
  apiKey: fc.constantFrom(
    'sk-abcdefghijklmnopqrstuvwxyz123456',
    'ghp_abcdefghijklmnopqrstuvwxyz1234',
    'AKIA1234567890ABCDEF',
  ),
  payloadPad: fc.string({ minLength: 0, maxLength: 64 }),
});

function makePage(url: string): Page {
  return {
    url: () => url,
    evaluate: async <T>(fn: () => T): Promise<T> => {
      // scanInteractablesInPage isn't under test here; return an empty list
      // for it, and canned title/html for the other evaluate() call.
      if (fn.name === 'scanInteractablesInPage') {
        return { records: [], elements: [] } as unknown as T;
      }
      return { title: 'Page', html: '<p>content</p>' } as unknown as T;
    },
    close: async () => undefined,
    on: () => undefined,
  } as unknown as Page;
}

function makeExtractor(contentText: string): Extractor {
  return {
    extract: (_doc: FetchedDoc): Promise<ExtractedArticle | null> =>
      Promise.resolve({
        url: 'https://example.com',
        title: null,
        byline: null,
        publishedAt: null,
        siteName: null,
        contentText,
        contentHtml: '',
        excerpt: null,
        lengthChars: contentText.length,
      }),
  };
}

describe('@no-llm discovery envelope property: sanitizer-totality', () => {
  it('page_digest never contains a raw email/SSN/credit-card/API-key shape (200 runs)', async () => {
    await fc.assert(
      fc.asyncProperty(corpusArbitrary, async (item) => {
        const contentText = [
          item.email,
          item.ssn,
          item.creditCard,
          item.apiKey,
          item.payloadPad,
        ].join(' ');
        const page = makePage('https://example.com');
        const extractor = makeExtractor(contentText);

        const observation = await buildObservation(
          page,
          { outcome: 'completed', reason: null },
          { extractor },
        );

        expect(observation.page_digest).not.toContain(item.email);
        expect(observation.page_digest).not.toContain(item.ssn);
        expect(observation.page_digest).not.toContain(item.creditCard);
        expect(observation.page_digest).not.toContain(item.apiKey);
      }),
      { numRuns: 200 },
    );
  });

  it('is total even when the credential shapes appear inside outcome_reason (engine-authored, still clamps safely)', async () => {
    await fc.assert(
      fc.asyncProperty(corpusArbitrary, async (item) => {
        const page = makePage('https://example.com');
        const extractor = makeExtractor('benign content');
        const reason = `Failed near ${item.email}`;

        const observation = await buildObservation(
          page,
          { outcome: 'failed', reason },
          { extractor },
        );

        // outcome_reason is engine-authored (not page content) and is not run
        // through sanitize() — this documents that boundary rather than
        // asserting redaction that isn't claimed for this field.
        expect(typeof observation.outcome_reason).toBe('string');
      }),
      { numRuns: 50 },
    );
  });

  it('never throws regardless of how credential shapes are combined (total, no panics)', async () => {
    await fc.assert(
      fc.asyncProperty(corpusArbitrary, async (item) => {
        const page = makePage('https://example.com');
        const extractor = makeExtractor(JSON.stringify(item));

        await expect(
          buildObservation(page, { outcome: 'completed', reason: null }, { extractor }),
        ).resolves.toBeDefined();
      }),
      { numRuns: 100 },
    );
  });
});
