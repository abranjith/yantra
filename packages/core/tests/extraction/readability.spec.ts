import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ReadabilityExtractor } from '../../src/extraction/readability.js';
import type { FetchedDoc } from '../../src/extraction/types.js';

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
