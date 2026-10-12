import { describe, expect, it } from 'vitest';

import {
  ENTITY_BYTES_MAX,
  JSONLD_SCRIPT_BYTES,
  MAX_PROPS,
  MAX_STRUCTURED,
  PROP_STRING_MAX,
  SCHEMA_TYPE_ALLOWLIST,
  SCHEMA_TYPE_ROOTS,
  SUBTYPE_OF,
  findJsonLdString,
  parseJsonLdBlocks,
  rootTypeOf,
} from '../../../src/extraction/page/structured.js';
import type { StructuredEntity } from '../../../src/extraction/page/types.js';

import { analyzeWithoutArticle, documentWith, pageFixture } from './helpers.js';

/** A page whose head carries the given JSON-LD values, one script each. */
function jsonLdPage(...values: readonly unknown[]): string {
  const scripts = values
    .map(
      (value) =>
        `<script type="application/ld+json">${typeof value === 'string' ? value : JSON.stringify(value)}</script>`,
    )
    .join('');
  return documentWith('<main><p>Shell.</p></main>', scripts);
}

function entitiesOf(html: string): readonly StructuredEntity[] {
  return analyzeWithoutArticle(html).structured;
}

const product = (n: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  '@type': 'Product',
  name: `Product ${n}`,
  url: `https://shop.test/p/${n}`,
  offers: { '@type': 'Offer', price: 10 + n, priceCurrency: 'USD' },
  ...extra,
});

describe('@no-llm extraction/page/structured', () => {
  describe('json-ld-itemlist', () => {
    const page = analyzeWithoutArticle(
      pageFixture('json-ld-itemlist.html'),
      'https://shop.test/paddles',
    );
    const products = page.structured.filter((entity) => entity.type === 'Product');

    it('returns the six Product entities with flattened offer and seller props', () => {
      expect(products).toHaveLength(6);
      expect(products[0]).toEqual({
        type: 'Product',
        from: 'json-ld',
        props: {
          name: 'Touring paddle 220',
          url: 'https://shop.test/p/1',
          color: 'Sunset Orange',
          'offers.@type': 'Offer',
          'offers.price': 129,
          'offers.priceCurrency': 'USD',
          'offers.seller.@type': 'Organization',
          'offers.seller.name': 'Riverbend Paddle Co',
        },
      });
    });

    it('reads a structured-only listing as a collection', () => {
      expect(page.shape).toBe('collection');
      expect(page.coverage.shape_basis).toMatch(/^collection: 6 structured entities/u);
    });

    it('lists shown types and counts the non-allowlisted ones', () => {
      expect(page.coverage.structured).toEqual({
        found: 7,
        shown: 7,
        types: ['ItemList', 'Product'],
        ignored_types: ['BreadcrumbList'],
        malformed: 0,
        skipped_bytes: 0,
      });
    });

    it('keeps the ItemList entity without duplicating its items', () => {
      const list = page.structured.find((entity) => entity.type === 'ItemList');
      expect(list?.props).toEqual({ name: 'Paddles' });
    });
  });

  describe('microdata-product', () => {
    it('returns one entity with the same dotted keys as JSON-LD', () => {
      const page = analyzeWithoutArticle(pageFixture('microdata-product.html'));
      expect(page.structured).toEqual([
        {
          type: 'Product',
          from: 'microdata',
          props: {
            name: 'Two-burner camp stove',
            color: 'Forest Green',
            sku: 'CS-2B',
            'offers.@type': 'Offer',
            'offers.price': '84.95',
            'offers.priceCurrency': 'USD',
            'offers.seller.@type': 'Organization',
            'offers.seller.name': 'Trailhead Supply',
          },
        },
      ]);
      expect(page.shape).toBe('detail');
    });

    it('collects repeated itemprops as a list', () => {
      const html = documentWith(
        '<div itemscope itemtype="https://schema.org/Place"><span itemprop="name">Pier</span><span itemprop="keywords">fishing</span><span itemprop="keywords">boats</span></div>',
      );
      expect(entitiesOf(html)[0]?.props).toEqual({ name: 'Pier', keywords: 'fishing, boats' });
    });
  });

  describe('bounds', () => {
    it('skips and counts a script over JSONLD_SCRIPT_BYTES', () => {
      const big = JSON.stringify(product(1, { description: 'a'.repeat(300 * 1024) }));
      const page = analyzeWithoutArticle(jsonLdPage(big, product(2)));
      expect(page.structured.map((entity) => entity.props.name)).toEqual(['Product 2']);
      expect(page.coverage.structured?.malformed).toBe(1);
      expect(page.coverage.structured?.skipped_bytes).toBeGreaterThan(JSONLD_SCRIPT_BYTES);
      expect(page.coverage.omitted).toContainEqual({
        id: 'structured-blocks-skipped',
        count: page.coverage.structured?.skipped_bytes,
      });
    });

    it('stops reading once JSONLD_TOTAL_BYTES is spent', () => {
      const block = (n: number): string =>
        JSON.stringify(product(n, { description: 'b'.repeat(200 * 1024) }));
      const blocks = parseJsonLdBlocks([1, 2, 3, 4, 5, 6].map(block));
      expect(blocks.values).toHaveLength(5);
      expect(blocks.malformed).toBe(1);
    });

    it('cuts depth-8 nesting at four key segments without throwing', () => {
      let nested: Record<string, unknown> = { leaf: 'deep' };
      for (const key of ['h', 'g', 'f', 'e', 'd', 'c', 'b']) nested = { [key]: nested };
      const [entity] = entitiesOf(jsonLdPage({ '@type': 'Product', name: 'Deep', a: nested }));
      expect(entity?.props.name).toBe('Deep');
      expect(Object.keys(entity?.props ?? {}).every((key) => key.split('.').length <= 4)).toBe(
        true,
      );
    });

    it('shows MAX_STRUCTURED of 80 entities', () => {
      const page = analyzeWithoutArticle(
        jsonLdPage(Array.from({ length: 80 }, (_, n) => product(n))),
      );
      expect(page.structured).toHaveLength(MAX_STRUCTURED);
      expect(page.coverage.structured?.found).toBe(80);
      expect(page.coverage.omitted).toContainEqual({ id: 'structured-beyond-limit', count: 55 });
    });

    it('cuts a 5 KB string to PROP_STRING_MAX characters', () => {
      const [entity] = entitiesOf(jsonLdPage(product(1, { description: 'c'.repeat(5_000) })));
      expect(String(entity?.props.description).length).toBe(PROP_STRING_MAX);
    });

    it('keeps at most MAX_PROPS properties and ENTITY_BYTES_MAX bytes per entity', () => {
      const many = Object.fromEntries(Array.from({ length: 70 }, (_, n) => [`k${n}`, n]));
      const [counted] = entitiesOf(jsonLdPage(product(1, many)));
      expect(Object.keys(counted?.props ?? {})).toHaveLength(MAX_PROPS);

      const wide = Object.fromEntries(
        Array.from({ length: 30 }, (_, n) => [`s${n}`, 'w'.repeat(250)]),
      );
      const [sized] = entitiesOf(jsonLdPage(product(1, wide)));
      expect(Buffer.byteLength(JSON.stringify(sized?.props), 'utf8')).toBeLessThanOrEqual(
        ENTITY_BYTES_MAX,
      );
    });

    it('joins scalar arrays and indexes at most three objects of an array', () => {
      const [entity] = entitiesOf(
        jsonLdPage(
          product(1, {
            keywords: ['light', 'carbon', 7],
            offers: [1, 2, 3, 4].map((n) => ({ price: n })),
          }),
        ),
      );
      expect(entity?.props.keywords).toBe('light, carbon, 7');
      expect(Object.keys(entity?.props ?? {}).filter((key) => key.startsWith('offers.'))).toEqual([
        'offers.0.price',
        'offers.1.price',
        'offers.2.price',
      ]);
    });

    it('drops @context and @id', () => {
      const [entity] = entitiesOf(
        jsonLdPage({ '@context': 'https://schema.org', '@id': '#p', ...product(1) }),
      );
      expect(
        Object.keys(entity?.props ?? {}).some(
          (key) => key.includes('@context') || key.includes('@id'),
        ),
      ).toBe(false);
    });
  });

  describe('parsing', () => {
    it('counts a malformed block and still parses the others', () => {
      const page = analyzeWithoutArticle(jsonLdPage('{ "@type": "Product", ', product(2)));
      expect(page.structured.map((entity) => entity.props.name)).toEqual(['Product 2']);
      expect(page.coverage.structured?.malformed).toBe(1);
    });

    it('accepts a multi-valued @type with one allowlisted entry and ignores WebPage', () => {
      const page = analyzeWithoutArticle(
        jsonLdPage(
          { '@type': ['Thing', 'Product'], name: 'Dual' },
          { '@type': 'WebPage', name: 'Page' },
        ),
      );
      expect(page.structured.map((entity) => entity.type)).toEqual(['Product']);
      expect(page.coverage.structured?.ignored_types).toEqual(['WebPage']);
    });

    it('walks @graph and top-level arrays, and normalizes type IRIs', () => {
      const page = analyzeWithoutArticle(
        jsonLdPage({ '@graph': [{ '@type': 'https://schema.org/Car', name: 'Wagon' }] }, [
          { '@type': 'schema:Hotel', name: 'Inn' },
        ]),
      );
      expect(page.structured.map((entity) => [entity.type, entity.props.name])).toEqual([
        ['Car', 'Wagon'],
        ['Hotel', 'Inn'],
      ]);
    });

    it('reads a ListItem that carries the item properties itself', () => {
      const list = {
        '@type': 'ItemList',
        itemListElement: [1, 2, 3].map((n) => ({
          '@type': ['ListItem', 'Product'],
          name: `L${n}`,
        })),
      };
      const page = analyzeWithoutArticle(jsonLdPage(list));
      expect(page.structured.filter((entity) => entity.type === 'Product')).toHaveLength(3);
      expect(page.shape).toBe('collection');
    });

    it('reads three top-level entities of one root as a collection', () => {
      const page = analyzeWithoutArticle(jsonLdPage(product(1), product(2), product(3)));
      expect(page.shape).toBe('collection');
    });

    it('reads one main entity with at least four props as a detail page', () => {
      const page = analyzeWithoutArticle(jsonLdPage(product(1, { color: 'Red' })));
      expect(page.shape).toBe('detail');
      expect(page.coverage.shape_basis).toMatch(/one structured Product entity/u);
    });

    it('finds a JSON-LD string property for the article reader', () => {
      const { values } = parseJsonLdBlocks([
        '{"@type":"NewsArticle","author":{"name":"A"},"datePublished":"2026-01-02"}',
      ]);
      expect(findJsonLdString(values, 'datePublished')).toBe('2026-01-02');
      expect(findJsonLdString(values, 'missing')).toBeUndefined();
    });
  });

  describe('untrusted input (plan §6)', () => {
    it('returns script-closing markup and javascript: URLs as inert strings', () => {
      const hostile = {
        '@type': 'Product',
        name: '</script><script>globalThis.__pwned = true</script>',
        url: 'javascript:alert(1)',
      };
      // The page escapes `<` the way a JSON-LD emitter must, so the block survives HTML parsing.
      const html = jsonLdPage(JSON.stringify(hostile).replaceAll('<', '\\u003c'));
      const [entity] = entitiesOf(html);
      expect(entity?.props.name).toBe('</script><script>globalThis.__pwned = true</script>');
      expect(entity?.props.url).toBe('javascript:alert(1)');
      expect((globalThis as { __pwned?: unknown }).__pwned).toBeUndefined();
    });

    it('bounds a 10 MB repeated string without reading it', () => {
      const huge = `{"@type":"Product","name":"${'z'.repeat(10 * 1024 * 1024)}"}`;
      const started = Date.now();
      const page = analyzeWithoutArticle(jsonLdPage(huge));
      expect(page.structured).toEqual([]);
      expect(page.coverage.structured?.malformed).toBe(1);
      expect(Date.now() - started).toBeLessThan(10_000);
    });
  });

  describe('SCHEMA_TYPE_ALLOWLIST', () => {
    it('maps every listed subtype to exactly one root', () => {
      for (const type of SCHEMA_TYPE_ALLOWLIST) {
        expect({ type, root: rootTypeOf(type) }).toEqual({
          type,
          root: expect.stringMatching(
            new RegExp(`^(${SCHEMA_TYPE_ROOTS.join('|')})$`, 'u'),
          ) as unknown,
        });
      }
    });

    it('has no cycles and no parent outside the table', () => {
      for (const parent of Object.values(SUBTYPE_OF)) {
        expect(SCHEMA_TYPE_ALLOWLIST.has(parent)).toBe(true);
      }
      expect(rootTypeOf('Thing')).toBeNull();
      expect(rootTypeOf('BreadcrumbList')).toBeNull();
    });
  });
});
