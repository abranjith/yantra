import { load } from 'cheerio';
import { describe, expect, it } from 'vitest';

import { analyzePage, completeAnalysis } from '../../../src/extraction/page/analyze.js';

import { documentWith, extractPage, pageFixture } from './helpers.js';

const FIXTURES = [
  'hub.html',
  'links.html',
  'listing-cards.html',
  'listing-card-linked-seller.html',
  'facet-list.html',
  'json-ld-itemlist.html',
  'microdata-product.html',
  'multi-table.html',
  'detail-attributes.html',
  'article-with-infobox.html',
] as const;

describe('@no-llm extraction/page/analyze', () => {
  it.each(FIXTURES)('never mutates the parse it reads (%s)', (name) => {
    const $ = load(pageFixture(name));
    const before = $.html();
    analyzePage($, { baseUrl: 'https://site.test/list', fetchMode: 'http' });
    expect($.html()).toBe(before);
  });

  it.each(FIXTURES)('is deterministic (%s)', async (name) => {
    const first = await extractPage(pageFixture(name));
    const second = await extractPage(pageFixture(name));
    expect(second).toEqual(first);
  });

  it('reads a page of links with no content of its own as an index', async () => {
    const page = await extractPage(pageFixture('hub.html'), 'https://shop.test/departments');
    expect(page.shape).toBe('index');
    expect(page.links.map((link) => link.text)).toEqual(
      expect.arrayContaining(['Garden', 'Kitchen', 'Lighting', 'Storage']),
    );
    expect(page.coverage.shape_basis).toMatch(/^index: /u);
  });

  it('reads an empty body as empty (null shape)', async () => {
    const page = await extractPage(documentWith(''));
    expect(page.shape).toBeNull();
    expect(page.coverage.shape_basis).toMatch(/^empty: /u);
    expect(page.coverage.not_found).toEqual([
      'no repeated records',
      'no structured data',
      'no tables',
      'no label/value fields',
      'no followable links',
      'no readable article',
    ]);
  });

  it('reads a page whose only links are chrome as empty', () => {
    const scan = analyzePage(load(documentWith('<nav><a href="/a">A</a></nav>')), {
      baseUrl: 'https://site.test/p',
      fetchMode: 'http',
    });
    expect(completeAnalysis(scan, { articleText: null, fallbackText: '' }).shape).toBeNull();
  });

  it('uses the article text as readable text, else the fallback', () => {
    const scan = analyzePage(load(documentWith('<p>x</p>')), {
      baseUrl: 'https://site.test/p',
      fetchMode: 'browser',
    });
    expect(
      completeAnalysis(scan, { articleText: 'Prose.', fallbackText: 'other' }).readableText,
    ).toBe('Prose.');
    const fallback = completeAnalysis(scan, { articleText: null, fallbackText: 'Visible.' });
    expect(fallback.readableText).toBe('Visible.');
    expect(fallback.coverage.fetch_mode).toBe('browser');
    expect(fallback.coverage.text).toEqual({ chars: 8, shown: 8 });
  });

  it('survives deeply nested markup without recursion limits', async () => {
    const depth = 5_000;
    const html = documentWith(
      `${'<div>'.repeat(depth)}<p>Deep text with <a href="/deep">a link</a>.</p>${'</div>'.repeat(depth)}`,
    );
    const page = await extractPage(html);
    expect(page.links.map((link) => link.url)).toContain('https://site.test/deep');
  });
});
