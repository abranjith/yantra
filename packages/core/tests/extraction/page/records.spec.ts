import { describe, expect, it } from 'vitest';

import {
  MAX_RECORDS,
  RECORD_TEXT_CHARS,
  numericTokens,
} from '../../../src/extraction/page/records.js';
import type { PageRecord } from '../../../src/extraction/page/types.js';

import { analyzeWithoutArticle, documentWith, extractPage, pageFixture } from './helpers.js';

/** Every visible string a record carries, for "does it contain X" checks. */
function recordText(record: PageRecord): string {
  return [
    record.title ?? '',
    ...record.segments,
    ...record.fields.map((field) => `${field.label}: ${field.value}`),
  ].join('\n');
}

function card(n: number, extra = ''): string {
  return `<li><h3><a href="/item/${n}">Item number ${n} title</a></h3><p>$${100 + n}.00 · Seller ${n}</p>${extra}</li>`;
}

describe('@no-llm extraction/page/records', () => {
  describe('listing-cards', () => {
    const page = analyzeWithoutArticle(
      pageFixture('listing-cards.html'),
      'https://bikes.test/search',
    );

    it('reads six cards as six records', () => {
      expect(page.shape).toBe('collection');
      expect(page.records).toHaveLength(6);
      expect(page.coverage.records).toEqual({
        found: 6,
        shown: 6,
        with_link: 6,
        with_fields: 0,
        truncated: 0,
        other_regions: 0,
      });
    });

    it('gives each record a title, its detail URL, a currency, a distance, and the seller line', () => {
      for (const record of page.records) {
        expect(record.title).toMatch(/\S/u);
        expect(record.url).toMatch(/^https:\/\/bikes\.test\/bikes\/10\d$/u);
        expect(record.numbers.map((token) => token.kind)).toEqual(['currency', 'distance']);
        expect(record.segments.some((segment) => / · \d+\.\d mi$/u.test(segment))).toBe(true);
      }
      expect(page.records[0]).toEqual({
        key: 'https://bikes.test/bikes/101',
        title: 'Trail 29 hardtail',
        url: 'https://bikes.test/bikes/101',
        segments: ['$1,240', 'Ridgeline Cycles · 12.3 mi', 'View listing'],
        fields: [],
        numbers: [
          { kind: 'currency', text: '$1,240', value: 1240 },
          { kind: 'distance', text: '12.3 mi', value: 12.3 },
        ],
        links: [],
      });
    });

    it('excludes record primary links from links[] and counts them', () => {
      expect(page.links.some((link) => link.url.includes('/bikes/'))).toBe(false);
      expect(page.recordLinkCount).toBe(6);
      expect(page.coverage.links?.by_kind.record).toBe(6);
    });
  });

  describe('G2 regression: listing-card-linked-seller (plan §9)', () => {
    const page = analyzeWithoutArticle(
      pageFixture('listing-card-linked-seller.html'),
      'https://home.test/results',
    );

    it('keeps the linked seller as a segment of a card whose price is plain text', () => {
      expect(page.shape).toBe('collection');
      expect(page.records).toHaveLength(3);
      const [first] = page.records;
      expect(first?.title).toBe('Compact dehumidifier 20 pint');
      expect(first?.segments).toContain('Brookside Supply');
      for (const [record, seller] of page.records.map(
        (entry, n) =>
          [entry, ['Brookside Supply', 'Ironwood Home', 'Oak and Ash Outfitters'][n]] as const,
      )) {
        expect(recordText(record)).toContain(seller);
      }
      expect(first?.segments).toContain('189.00 List $219.00');
      expect(first?.links).toEqual([
        { text: 'Brookside Supply', url: 'https://home.test/seller/brookside-supply' },
      ]);
    });

    it('offers the seller links in links[] as content links', () => {
      expect(
        page.links.filter((link) => link.url.includes('/seller/')).map((link) => link.kind),
      ).toEqual(['content', 'content', 'content']);
    });
  });

  describe('facet-list', () => {
    const page = analyzeWithoutArticle(pageFixture('facet-list.html'), 'https://camp.test/tents');

    it('turns the sidebar into facet links and never into records', () => {
      const facets = page.links.filter((link) => link.kind === 'facet');
      expect(facets.map((link) => link.text)).toEqual([
        '2 person (44)',
        '4 person (31)',
        '6 person (12)',
        'Three season 18',
        'Four season 9',
      ]);
      expect(page.records.map((record) => record.url)).toEqual([
        'https://camp.test/tents/item/t1',
        'https://camp.test/tents/item/t2',
        'https://camp.test/tents/item/t3',
        'https://camp.test/tents/item/t4',
      ]);
    });

    it('ranks facet links right after pagination', () => {
      expect(page.links[0]?.kind).toBe('facet');
    });

    it('recognizes a facet list on its own, with no records beside it', () => {
      const sidebarOnly = analyzeWithoutArticle(
        documentWith(
          '<ul><li><a href="/tents?c=a">Alpha (3)</a></li><li><a href="/tents?c=b">Beta (5)</a></li><li><a href="/tents?c=c">Gamma (7)</a></li></ul>',
        ),
        'https://camp.test/tents',
      );
      expect(sidebarOnly.records).toEqual([]);
      expect(sidebarOnly.links.map((link) => link.kind)).toEqual(['facet', 'facet', 'facet']);
    });

    it('counts a selected value (a link to the page itself) toward its group', () => {
      const html = documentWith(
        '<ul><li><a href="/tents?drive=a">Alpha (4)</a></li><li><a href="/tents?drive=b">Beta (2)</a></li></ul>',
      );
      const selected = analyzeWithoutArticle(html, 'https://camp.test/tents?drive=a');
      expect(selected.links).toEqual([
        { text: 'Beta (2)', url: 'https://camp.test/tents?drive=b', kind: 'facet', sameSite: true },
      ]);
    });

    it('does not mistake a numbered page list for a facet group', () => {
      const html = documentWith(
        '<ul><li><a href="/tents?page=2">2</a></li><li><a href="/tents?page=3">3</a></li></ul>',
      );
      const numbered = analyzeWithoutArticle(html, 'https://camp.test/tents');
      expect(numbered.links.map((link) => link.kind)).toEqual(['pagination', 'pagination']);
    });

    it('rejects items that link away from the page', () => {
      const html = documentWith(
        '<ul><li><a href="https://far.test/a">Alpha (4)</a></li><li><a href="https://far.test/b">Beta (2)</a></li></ul>',
      );
      const away = analyzeWithoutArticle(html, 'https://camp.test/tents');
      expect(away.links.every((link) => link.kind === 'content')).toBe(true);
    });
  });

  describe('region choice', () => {
    it('takes cards, not card fragments, when each card holds its own repeating list', () => {
      const specs = (n: number): string =>
        `<ul>${[1, 2, 3].map((s) => `<li><a href="/spec/${n}/${s}">Specification line ${s} of item ${n}</a></li>`).join('')}</ul>`;
      const html = documentWith(
        `<main><ol>${[1, 2, 3, 4].map((n) => card(n, specs(n))).join('')}</ol></main>`,
      );
      const page = analyzeWithoutArticle(html);
      expect(page.records.map((record) => record.url)).toEqual([
        'https://site.test/item/1',
        'https://site.test/item/2',
        'https://site.test/item/3',
        'https://site.test/item/4',
      ]);
      expect(page.coverage.records?.other_regions).toBeGreaterThan(0);
    });

    it('does not read a 12-item navigation menu as a collection', () => {
      const items = Array.from(
        { length: 12 },
        (_, n) => `<li><a href="/category/${n}">Category ${n}</a></li>`,
      ).join('');
      const page = analyzeWithoutArticle(
        documentWith(`<nav aria-label="Main"><ul>${items}</ul></nav><main><p>Welcome.</p></main>`),
      );
      expect(page.records).toEqual([]);
      expect(page.shape).not.toBe('collection');
    });

    it('penalizes a repeated region inside a landmark against one in the content', () => {
      const list = (prefix: string): string =>
        `<ul>${[1, 2, 3].map((n) => `<li><a href="/${prefix}/${n}">${prefix} entry number ${n} with words</a></li>`).join('')}</ul>`;
      const html = documentWith(
        `<aside>${list('sidebar')}${list('more')}</aside><main>${list('main')}</main>`,
      );
      const page = analyzeWithoutArticle(html);
      expect(page.records.map((record) => record.url)).toEqual([
        'https://site.test/main/1',
        'https://site.test/main/2',
        'https://site.test/main/3',
      ]);
    });

    it('needs MIN_RECORDS similar siblings', () => {
      const page = analyzeWithoutArticle(documentWith(`<ol>${card(1)}${card(2)}</ol>`));
      expect(page.records).toEqual([]);
      expect(page.coverage.not_found).toContain('no repeated records');
    });

    it('finds the comment thread of an article as records', async () => {
      const page = await extractPage(pageFixture('comment-thread.html'), 'https://home.test/guide');
      expect(page.coverage.records?.found).toBe(10);
    });
  });

  describe('per-record fields', () => {
    it('reads dt/dd, two-cell rows, and "Label: value" segments as fields, not segments', () => {
      const body = (n: number): string =>
        `<li><h3><a href="/r/${n}">Room ${n}</a></h3><dl><dt>Beds</dt><dd>${n}</dd></dl>` +
        `<table><tr><th>View</th><td>Garden</td></tr></table><p>Floor: ${n + 2}</p><p>Free cancellation</p></li>`;
      const page = analyzeWithoutArticle(documentWith(`<ol>${[1, 2, 3].map(body).join('')}</ol>`));
      expect(page.records[0]?.fields).toEqual([
        { label: 'Beds', value: '1' },
        { label: 'View', value: 'Garden' },
        { label: 'Floor', value: '3' },
      ]);
      expect(page.records[0]?.segments).toEqual(['Free cancellation']);
      expect(page.coverage.records?.with_fields).toBe(3);
    });

    it('keeps at most 8 fields per record', () => {
      const lines = Array.from({ length: 12 }, (_, n) => `<p>Attr ${n}: v${n}</p>`).join('');
      const page = analyzeWithoutArticle(
        documentWith(`<ol>${[1, 2, 3].map((n) => card(n, lines)).join('')}</ol>`),
      );
      expect(page.records[0]?.fields).toHaveLength(8);
    });

    it('keeps at most 3 secondary links, primary excluded', () => {
      const extra = [1, 2, 3, 4].map((s) => `<p><a href="/other/${s}">Other ${s}</a></p>`).join('');
      const page = analyzeWithoutArticle(
        documentWith(
          `<ol>${[1, 2, 3].map((n) => card(n, `<a href="/item/${n}">Again</a>${extra}`)).join('')}</ol>`,
        ),
      );
      expect(page.records[0]?.links.map((link) => link.url)).toEqual([
        'https://site.test/other/1',
        'https://site.test/other/2',
        'https://site.test/other/3',
      ]);
    });
  });

  describe('identity', () => {
    it('keys a record by its canonical primary URL', () => {
      const page = analyzeWithoutArticle(
        documentWith(
          `<ol>${[1, 2, 3].map((n) => `<li><h3><a href="/item/${n}/?utm_source=x#top">Item ${n} title text</a></h3><p>Price $${n}.00</p></li>`).join('')}</ol>`,
        ),
      );
      expect(page.records.map((record) => record.key)).toEqual([
        'https://site.test/item/1',
        'https://site.test/item/2',
        'https://site.test/item/3',
      ]);
    });

    it('suffixes a repeated key so anchors stay distinct', () => {
      const same = '<li><h3><a href="/item/x">Same target item</a></h3><p>$5 each</p></li>';
      const page = analyzeWithoutArticle(documentWith(`<ol>${same}${same}${same}</ol>`));
      expect(page.records.map((record) => record.key)).toEqual([
        'https://site.test/item/x',
        'https://site.test/item/x#2',
        'https://site.test/item/x#3',
      ]);
    });

    it('hashes the title and first segment when a record has no followable link', () => {
      const item = (n: number): string =>
        `<li><h3><a href="javascript:void(0)">Item ${n} title</a></h3><p>Detail line ${n}</p></li>`;
      const html = documentWith(`<ol>${[1, 2, 3].map(item).join('')}</ol>`);
      const [first, second] = [analyzeWithoutArticle(html), analyzeWithoutArticle(html)];
      expect(first.records[0]?.url).toBeNull();
      expect(first.records[0]?.key).toMatch(/^h:[0-9a-f]{16}$/u);
      expect(second.records[0]?.key).toBe(first.records[0]?.key);
      expect(new Set(first.records.map((record) => record.key)).size).toBe(3);
    });
  });

  describe('bounds', () => {
    it('shows 25 of 60 cards and says so, without a pagination phrase when none is offered', () => {
      const html = documentWith(
        `<ol>${Array.from({ length: 60 }, (_, n) => card(n)).join('')}</ol>`,
      );
      const page = analyzeWithoutArticle(html);
      expect(page.records).toHaveLength(MAX_RECORDS);
      expect(page.coverage.records?.found).toBe(60);
      expect(page.coverage.omitted).toContainEqual({
        id: 'records-beyond-limit',
        count: 35,
        paginationOffered: false,
      });
    });

    it('notes the pagination link when the page offers one', () => {
      const html = documentWith(
        `<ol>${Array.from({ length: 30 }, (_, n) => card(n)).join('')}</ol><a rel="next" href="/list?page=2">Next</a>`,
      );
      expect(analyzeWithoutArticle(html).coverage.omitted).toContainEqual({
        id: 'records-beyond-limit',
        count: 5,
        paginationOffered: true,
      });
    });

    it('cuts a 2,000-character card to 400 characters at a whole-segment boundary', () => {
      // Distinct words: the shared normalization collapses adjacent repeats.
      const filler = (n: number): string =>
        Array.from({ length: 14 }, (_, k) => `w${n}k${k}`).join(' ');
      const paragraphs = Array.from(
        { length: 20 },
        (_, n) => `<p>Paragraph ${String(n).padStart(2, '0')} ${filler(n)} end</p>`,
      ).join('');
      const html = documentWith(`<ol>${[1, 2, 3].map((n) => card(n, paragraphs)).join('')}</ol>`);
      const page = analyzeWithoutArticle(html);
      const [first] = page.records;
      const kept = [first?.title ?? '', ...(first?.segments ?? [])].join('').length;
      expect(kept).toBeLessThanOrEqual(RECORD_TEXT_CHARS);
      expect(first?.segments.every((segment) => /^(\$|Paragraph \d\d )/u.test(segment))).toBe(true);
      expect(first?.segments.at(-1)).toMatch(/ end$/u);
      expect(page.coverage.records?.truncated).toBe(3);
      expect(page.coverage.omitted).toContainEqual({ id: 'record-text-cut', count: 3 });
    });
  });

  it('is deterministic', () => {
    const html = pageFixture('listing-cards.html');
    expect(analyzeWithoutArticle(html)).toEqual(analyzeWithoutArticle(html));
  });

  describe('numericTokens', () => {
    it.each([
      ['$1,240 today', [{ kind: 'currency', text: '$1,240', value: 1240 }]],
      ['€ 15.50', [{ kind: 'currency', text: '€ 15.50', value: 15.5 }]],
      ['299 £', [{ kind: 'currency', text: '299 £', value: 299 }]],
      ['USD 45,000', [{ kind: 'currency', text: 'USD 45,000', value: 45000 }]],
      ['45,000 EUR', [{ kind: 'currency', text: '45,000 EUR', value: 45000 }]],
      ['AWD 2026', []],
      ['12.3 mi away', [{ kind: 'distance', text: '12.3 mi', value: 12.3 }]],
      ['8 km', [{ kind: 'distance', text: '8 km', value: 8 }]],
      ['3 miles', [{ kind: 'distance', text: '3 miles', value: 3 }]],
      ['Reviews (1,204)', [{ kind: 'count', text: '(1,204)', value: 1204 }]],
      ['5 minutes', []],
    ])('%s', (text, expected) => {
      expect(numericTokens(text)).toEqual(expected);
    });

    it('returns tokens in text order and at most the limit', () => {
      const text = '(1) $2 3 mi (4) $5 6 km (7) $8';
      expect(numericTokens(text).map((token) => token.value)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(numericTokens(text, 2)).toHaveLength(2);
    });
  });
});
