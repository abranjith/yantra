import { describe, expect, it } from 'vitest';

import {
  ARTICLE_MASS_WEIGHT,
  FIELD_FACT_CHARS,
  classifyShape,
  fieldMass,
  type ShapeEvidence,
} from '../../../src/extraction/page/shape.js';
import { ReadabilityExtractor } from '../../../src/extraction/readability.js';

import { documentWith, extractPage, makeDoc, pageFixture } from './helpers.js';

const NONE: ShapeEvidence = {
  articleChars: null,
  articleProseChars: 0,
  records: { count: 0, chars: 0, qualifies: false },
  structuredCollection: { count: 0, chars: 0, qualifies: false },
  tables: { count: 0, chars: 0 },
  fields: { count: 0, chars: 0, mass: 0 },
  mainEntity: null,
  followableLinks: 0,
  minorParts: { tables: 0, fields: 0 },
};

/** A results page of `count` cards, each with a few lines of card text. */
function bigListing(count: number): string {
  const cards = Array.from(
    { length: count },
    (_, n) =>
      `<li><h3><a href="/v/${n}">Listing number ${n} sport utility</a></h3>` +
      `<p>$${30_000 + n * 17}</p><p><a href="/s/${n % 5}">Dealer group ${n % 5}</a></p>` +
      `<p>${(n * 1.7).toFixed(1)} mi away</p><p>Certified, one owner, service records available</p></li>`,
  ).join('');
  return documentWith(
    `<main><h1>Results</h1><p>Showing ${count} results for your search.</p><ol>${cards}</ol></main>`,
  );
}

describe('@no-llm extraction/page/shape', () => {
  describe('arbitration on fixtures', () => {
    it('reads a long article with a comment thread as an article', async () => {
      const page = await extractPage(pageFixture('comment-thread.html'), 'https://home.test/guide');
      expect(page.coverage.records?.found).toBe(10);
      expect(page.shape).toBe('article');
    });

    it('reads an article with an infobox as an article and returns the box as fields', async () => {
      const doc = makeDoc('https://home.test/insulation', pageFixture('article-with-infobox.html'));
      const extractor = new ReadabilityExtractor();
      const [{ page }, article] = [await extractor.extractPage(doc), await extractor.extract(doc)];
      expect(page.shape).toBe('article');
      expect(page.readableText).toBe(article?.contentText);
      expect(page.fields).toContainEqual({ label: 'Typical R-value', value: 'R-49 attic' });
      expect(page.fields).toHaveLength(10);
    });

    it('reads the G2 listing as a collection even though Readability keeps card fragments', async () => {
      const page = await extractPage(bigListing(24), 'https://cars.test/results');
      expect(page.shape).toBe('collection');
      expect(page.records).toHaveLength(24);
      expect(page.coverage.shape_basis).toMatch(
        /^collection: 24 repeated records \([\d,]+ chars\) outweighed article text \([\d,]+ chars, [\d,]+ not returned/u,
      );
    });

    it('reads a structured-only listing shell as a collection', async () => {
      const page = await extractPage(
        pageFixture('json-ld-itemlist.html'),
        'https://shop.test/paddles',
      );
      expect(page.shape).toBe('collection');
    });

    it('reads a hub of links with no prose of its own as an index', async () => {
      const page = await extractPage(pageFixture('hub.html'), 'https://shop.test/departments');
      expect(page.shape).toBe('index');
    });

    it('keeps an article whose text happens to contain a few label lines an article', async () => {
      const prose = Array.from(
        { length: 8 },
        (_, n) =>
          `<p>Paragraph ${n} explains the background in full sentences, covering causes, effects, and what readers can do about it this season.</p>`,
      ).join('');
      const html = documentWith(
        `<main><article><h1>Story</h1><p>By: Staff</p><p>Updated: Monday</p>${prose}</article></main>`,
      );
      expect((await extractPage(html)).shape).toBe('article');
    });
  });

  describe('classifyShape', () => {
    it('breaks ties collection > table > detail > article', () => {
      const tied: ShapeEvidence = {
        ...NONE,
        articleChars: 400,
        articleProseChars: 200,
        records: { count: 3, chars: 100, qualifies: true },
        tables: { count: 1, chars: 100 },
        fields: { count: 0, chars: 0, mass: 0 },
        mainEntity: { type: 'Product', chars: 100 },
      };
      expect(classifyShape(tied).shape).toBe('collection');
      expect(classifyShape({ ...tied, records: NONE.records }).shape).toBe('table');
      expect(classifyShape({ ...tied, records: NONE.records, tables: NONE.tables }).shape).toBe(
        'detail',
      );
    });

    it('discounts article text by ARTICLE_MASS_WEIGHT', () => {
      const evidence: ShapeEvidence = {
        ...NONE,
        articleChars: 1_000,
        articleProseChars: 1_000,
        records: { count: 5, chars: 1_000 * ARTICLE_MASS_WEIGHT + 1, qualifies: true },
      };
      expect(classifyShape(evidence).shape).toBe('collection');
      expect(
        classifyShape({
          ...evidence,
          records: { ...evidence.records, chars: 1_000 * ARTICLE_MASS_WEIGHT - 1 },
        }).shape,
      ).toBe('article');
    });

    it('needs four fields for a detail reading', () => {
      const fields = (count: number): ShapeEvidence['fields'] => ({
        count,
        chars: count * 10,
        mass: count * FIELD_FACT_CHARS,
      });
      expect(classifyShape({ ...NONE, fields: fields(4) }).shape).toBe('detail');
      expect(classifyShape({ ...NONE, fields: fields(3), followableLinks: 1 }).shape).not.toBe(
        'detail',
      );
    });

    it('needs prose of its own for an article reading', () => {
      expect(
        classifyShape({ ...NONE, articleChars: 50, articleProseChars: 0, followableLinks: 3 })
          .shape,
      ).toBe('index');
    });

    it('names the winner and the runner-up with both masses', () => {
      const decision = classifyShape({
        ...NONE,
        articleChars: 2_302,
        articleProseChars: 1_800,
        records: { count: 24, chars: 5_210, qualifies: true },
      });
      expect(decision.basis).toBe(
        'collection: 24 repeated records (5,210 chars) outweighed article text (2,302 chars, 1,800 not returned as records, fields, tables, or links)',
      );
    });

    it('says when no other shape qualified', () => {
      expect(classifyShape({ ...NONE, tables: { count: 1, chars: 90 } }).basis).toBe(
        'table: 1 data table (90 chars); no other shape qualified',
      );
    });

    it('falls back to minor parts, then links, then empty', () => {
      expect(
        classifyShape({ ...NONE, minorParts: { tables: 1, fields: 0 }, followableLinks: 2 }).shape,
      ).toBe('table');
      expect(classifyShape({ ...NONE, minorParts: { tables: 0, fields: 2 } }).shape).toBe('detail');
      expect(classifyShape({ ...NONE, followableLinks: 2 }).shape).toBe('index');
      expect(classifyShape(NONE)).toEqual({
        shape: null,
        basis:
          'empty: no readable article, records, tables, fields, structured data, or followable links',
      });
    });
  });

  it('floors each field at FIELD_FACT_CHARS in arbitration mass', () => {
    expect(fieldMass([{ label: 'Trim', value: 'Base' }])).toBe(FIELD_FACT_CHARS);
    const long = { label: 'Description', value: 'd'.repeat(100) };
    expect(fieldMass([long])).toBe(111);
  });
});
