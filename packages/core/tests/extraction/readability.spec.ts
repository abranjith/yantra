import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { load } from 'cheerio';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

import { ReadabilityExtractor } from '../../src/extraction/readability.js';
import type { ExtractedArticle, FetchedDoc } from '../../src/extraction/types.js';

function fixture(name: string): string {
  return readFileSync(resolve(import.meta.dirname, `./__fixtures__/${name}`), 'utf8');
}

function makeDoc(url: string, html: string): FetchedDoc {
  return {
    url,
    finalUrl: url,
    fetchedAt: '2026-05-11T10:14:00.000Z',
    contentType: 'text/html',
    html,
    statusCode: 200,
    fetchMode: 'http',
    elapsedMs: 10,
  };
}

describe('@no-llm extraction/readability', () => {
  it('extracts long-form article content', async () => {
    const extractor = new ReadabilityExtractor();
    const article = await extractor.extract(
      makeDoc('https://news.example/article', fixture('article.html')),
    );

    expect(article).not.toBeNull();
    expect(article?.title).toBe('AI News Roundup');
    expect(article?.contentText.length ?? 0).toBeGreaterThan(150);
    expect(article?.publishedAt).toBe('2026-05-10T12:00:00.000Z');
  });

  it('returns null for js-only pages with no readable content', async () => {
    const extractor = new ReadabilityExtractor();
    const article = await extractor.extract(
      makeDoc('https://spa.example', fixture('js-only-spa.html')),
    );

    expect(article).toBeNull();
  });

  it('extracts short paywalled content', async () => {
    const extractor = new ReadabilityExtractor();
    const article = await extractor.extract(
      makeDoc('https://news.example/paywall', fixture('paywall.html')),
    );

    expect(article).not.toBeNull();
    expect(article?.lengthChars ?? 0).toBeLessThan(500);
  });

  it('strips footnote sups, infobox, navbox, and reflist chrome before extraction', async () => {
    const extractor = new ReadabilityExtractor();
    const article = await extractor.extract(
      makeDoc('https://en.wikipedia.org/wiki/2026_FIFA_World_Cup', fixture('wiki-refs.html')),
    );

    expect(article).not.toBeNull();
    const text = article?.contentText ?? '';
    expect(text).not.toMatch(/\[\d{1,3}\]/u);
    expect(text).not.toMatch(/\[A\]/u);
    expect(text).not.toContain('[edit]');
    expect(text).not.toContain('Host countries');
    expect(text).not.toContain('Reference forty-five text');
    expect(text).not.toContain('Navigation: 1930');
    expect(text).toContain('The 2026 FIFA World Cup is the 23rd FIFA World Cup');
  });

  it('produces block-structured text with blank-line separators', async () => {
    const extractor = new ReadabilityExtractor();
    const article = await extractor.extract(
      makeDoc('https://en.wikipedia.org/wiki/2026_FIFA_World_Cup', fixture('wiki-refs.html')),
    );

    const blocks = (article?.contentText ?? '').split('\n\n');
    expect(blocks.length).toBeGreaterThanOrEqual(3);
    expect(article?.contentText ?? '').not.toMatch(/[a-z][A-Z]/u);
  });

  it('normalizes NBSP and whitespace runs in the extracted title', async () => {
    const extractor = new ReadabilityExtractor();
    const html = fixture('wiki-refs.html').replace(
      '<title>2026 FIFA World Cup - Wikipedia</title>',
      '<title>2026 FIFA  World Cup</title>',
    );
    const article = await extractor.extract(makeDoc('https://news.example/t', html));

    expect(article?.title).toBe('2026 FIFA World Cup');
  });

  it('handles malformed HTML without throwing', async () => {
    const extractor = new ReadabilityExtractor();
    const article = await extractor.extract(
      makeDoc('https://news.example/broken', fixture('malformed.html')),
    );

    expect(article === null || article.title === 'Broken').toBe(true);
  });
});

/**
 * Goldens captured from `extract()` before FEAT-051 refactored the extractor
 * (`__fixtures__/goldens/*.json`). Article pages must stay byte-identical on
 * both entry points.
 */
const GOLDENS = ['article', 'wiki-refs', 'paywall', 'malformed'] as const;

function golden(name: string): { url: string; article: ExtractedArticle | null } {
  return JSON.parse(fixture(`goldens/${name}.json`)) as {
    url: string;
    article: ExtractedArticle | null;
  };
}

describe('@no-llm extraction/readability shape-aware read (FEAT-051)', () => {
  it.each(GOLDENS)('extract() of %s is byte-identical to the pre-feature golden', async (name) => {
    const { url, article } = golden(name);
    const extracted = await new ReadabilityExtractor().extract(
      makeDoc(url, fixture(`${name}.html`)),
    );
    expect(extracted).toEqual(article);
    expect(extracted?.contentText).toBe(article?.contentText);
  });

  it.each(GOLDENS)('extractPage(%s).article deep-equals extract()', async (name) => {
    const { url } = golden(name);
    const doc = makeDoc(url, fixture(`${name}.html`));
    const extractor = new ReadabilityExtractor();
    const [page, article] = [await extractor.extractPage(doc), await extractor.extract(doc)];
    expect(page.article).toEqual(article);
    expect(page.article?.publishedAt ?? null).toBe(golden(name).article?.publishedAt ?? null);
  });

  it.each(['article', 'wiki-refs', 'paywall'] as const)(
    '%s still classifies as an article',
    async (name) => {
      const { url } = golden(name);
      const { page } = await new ReadabilityExtractor().extractPage(
        makeDoc(url, fixture(`${name}.html`)),
      );
      expect(page.shape).toBe('article');
      expect(page.readableText).toBe(golden(name).article?.contentText);
    },
  );

  it('parses the HTML exactly once on both entry points', async () => {
    let parses = 0;
    const extractor = new ReadabilityExtractor({
      parseHtml: (html) => {
        parses += 1;
        return load(html);
      },
    });
    const doc = makeDoc('https://news.example/article', fixture('article.html'));

    await extractor.extract(doc);
    expect(parses).toBe(1);

    parses = 0;
    await extractor.extractPage(doc);
    expect(parses).toBe(1);
  });

  it('builds one DOM for Readability on both entry points', async () => {
    let documents = 0;
    const extractor = new ReadabilityExtractor({
      createDocument: (html, url) => {
        documents += 1;
        return new JSDOM(html, { url }).window.document;
      },
    });
    const doc = makeDoc('https://news.example/article', fixture('article.html'));

    await extractor.extract(doc);
    expect(documents).toBe(1);

    documents = 0;
    await extractor.extractPage(doc);
    expect(documents).toBe(1);
  });

  it('serializes the no-article fallback from the same parse', async () => {
    let parses = 0;
    const extractor = new ReadabilityExtractor({
      parseHtml: (html) => {
        parses += 1;
        return load(html);
      },
      createDocument: () => new JSDOM('<html><body></body></html>').window.document,
    });
    const html =
      '<html><body><main><p>Visible words.</p></main><nav><a href="/x">Menu</a></nav></body></html>';

    const { article, page } = await extractor.extractPage(makeDoc('https://site.test/p', html));

    expect(article).toBeNull();
    expect(page.readableText).toBe('Visible words.');
    expect(parses).toBe(1);
  });

  it('keeps extract() and extractPage() null-safe on a script-only page', async () => {
    const doc = makeDoc('https://spa.example', fixture('js-only-spa.html'));
    const extractor = new ReadabilityExtractor();

    expect(await extractor.extract(doc)).toBeNull();
    const { article, page } = await extractor.extractPage(doc);
    expect(article).toBeNull();
    expect(page.coverage.not_found).toContain('no readable article');
  });

  it('reports a truncated source as an omission', async () => {
    const { page } = await new ReadabilityExtractor().extractPage(
      makeDoc('https://news.example/article', fixture('article.html')),
      { truncated: true },
    );
    expect(page.coverage.omitted).toContainEqual({ id: 'snapshot-truncated', count: 1 });
  });
});
