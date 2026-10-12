import { describe, expect, it } from 'vitest';

import {
  LINK_TEXT_MAX,
  MAX_LINKS,
  PAGINATION_WORDS,
  isUrlVariant,
} from '../../../src/extraction/page/links.js';
import type { PageLink } from '../../../src/extraction/page/types.js';

import { analyzeWithoutArticle, documentWith, pageFixture } from './helpers.js';

const PAGE = 'https://site.test/list';

function linksOf(html: string, url = PAGE): readonly PageLink[] {
  return analyzeWithoutArticle(html, url).links;
}

function urls(links: readonly PageLink[]): string[] {
  return links.map((link) => link.url);
}

describe('@no-llm extraction/page/links', () => {
  describe('harvest', () => {
    const links = linksOf(pageFixture('links.html'));

    it('resolves relative hrefs against the page URL', () => {
      expect(urls(links)).toContain('https://site.test/chapter-1');
      expect(urls(links)).toContain('https://site.test/list/chapter-2/');
    });

    it('resolves against <base href> when the document declares one', () => {
      const html = documentWith(
        '<p><a href="c">C</a></p>',
        '<base href="https://cdn.site.test/root/">',
      );
      expect(urls(linksOf(html))).toEqual(['https://cdn.site.test/root/c']);
    });

    it('drops javascript:, data:, mailto:, tel:, fragment-only, and same-document links', () => {
      const all = urls(links).join(' ');
      for (const dropped of ['javascript:', 'data:', 'mailto:', 'tel:', '#top']) {
        expect(all).not.toContain(dropped);
      }
      expect(urls(links)).not.toContain('https://site.test/list');
      expect(
        linksOf(documentWith('<p><a href="/list#top">self</a> <a href="/list/">self</a></p>')),
      ).toEqual([]);
    });

    it('skips links inside aria-hidden and hidden subtrees', () => {
      expect(urls(links).join(' ')).not.toContain('hidden');
    });

    it('dedupes one page linked as …/x/ and …/x#y, keeping the first text', () => {
      const chapterTwo = links.filter((link) => link.url.includes('chapter-2'));
      expect(chapterTwo).toEqual([
        {
          text: 'chapter two',
          url: 'https://site.test/list/chapter-2/',
          kind: 'content',
          sameSite: true,
        },
      ]);
    });

    it('names an image link by aria-label, then img alt', () => {
      expect(links.find((link) => link.url.endsWith('/appendix'))?.text).toBe('Appendix');
      expect(links.find((link) => link.url.endsWith('/glossary'))?.text).toBe('Glossary');
    });

    it('bounds link text at LINK_TEXT_MAX characters', () => {
      // Distinct words: the shared normalization collapses adjacent repeats.
      const long = Array.from({ length: 40 }, (_, n) => `term${n}`).join(' ');
      const [link] = linksOf(documentWith(`<p><a href="/long">${long}</a></p>`));
      expect(link?.text.length).toBe(LINK_TEXT_MAX);
    });

    it('keeps only http and https, including http pages', () => {
      const html = documentWith(
        '<p><a href="ftp://site.test/f">f</a> <a href="http://site.test/plain">p</a></p>',
      );
      expect(urls(linksOf(html))).toEqual(['http://site.test/plain']);
    });
  });

  describe('classification', () => {
    const links = linksOf(pageFixture('links.html'));
    const kindOf = (suffix: string): string | undefined =>
      links.find((link) => link.url.endsWith(suffix))?.kind;

    it('classifies rel=next and a numbered page group as pagination', () => {
      expect(kindOf('/list?page=2')).toBe('pagination');
      expect(kindOf('/list?page=3')).toBe('pagination');
    });

    it('treats a <link rel=next> in the head as pagination', () => {
      const html = documentWith('<p>Body text.</p>', '<link rel="next" href="/list?page=2">');
      expect(linksOf(html)).toEqual([
        { text: 'next', url: 'https://site.test/list?page=2', kind: 'pagination', sameSite: true },
      ]);
    });

    it('classifies a pagination word linking to a page variant as pagination', () => {
      const html = documentWith(
        '<p><a href="/list?offset=20">Next page</a> <a href="/archive/2020/list">Next</a> <a href="https://other.test/list?page=2">Older</a></p>',
      );
      const found = linksOf(html);
      expect(found.find((link) => link.url.endsWith('offset=20'))?.kind).toBe('pagination');
      // Not variants of the page: a path two segments away, another origin.
      expect(found.find((link) => link.url.endsWith('/archive/2020/list'))?.kind).toBe('content');
      expect(found.find((link) => link.url.startsWith('https://other.test'))?.kind).toBe('content');
    });

    it('treats a numbered group whose URLs differ in more than one slot as content', () => {
      const html = documentWith('<p><a href="/a?x=1&y=1">1</a><a href="/a?x=2&y=2">2</a></p>');
      expect(linksOf(html).every((link) => link.kind === 'content')).toBe(true);
    });

    it('classifies numbered path segments as pagination', () => {
      const html = documentWith(
        '<div><a href="/list/page/2">2</a><a href="/list/page/3">3</a></div>',
      );
      expect(linksOf(html).map((link) => link.kind)).toEqual(['pagination', 'pagination']);
    });

    it('classifies header and footer chrome as navigation', () => {
      expect(kindOf('/about')).toBe('navigation');
      expect(kindOf('/terms')).toBe('navigation');
    });

    it('does not treat a card-scoped <header> as page chrome', () => {
      const html = documentWith(
        '<article><header><a href="/story">Story</a></header><p>Body.</p></article>',
      );
      expect(linksOf(html)[0]?.kind).toBe('content');
    });

    it('honors explicit landmark roles', () => {
      const html = documentWith('<div role="navigation"><a href="/menu">Menu</a></div>');
      expect(linksOf(html)[0]?.kind).toBe('navigation');
    });
  });

  describe('ranking and bounds', () => {
    it('ranks by kind, then same-site before off-site, then document order', () => {
      const links = linksOf(pageFixture('links.html'));
      const kinds = links.map((link) => link.kind);
      const firstContent = kinds.indexOf('content');
      expect(kinds.slice(0, firstContent).every((kind) => kind === 'pagination')).toBe(true);
      expect(kinds.lastIndexOf('content')).toBeLessThan(kinds.indexOf('navigation'));
      const content = links.filter((link) => link.kind === 'content');
      expect(content.at(-1)?.url).toBe('https://elsewhere.test/guide');
      expect(content.slice(0, -1).every((link) => link.sameSite)).toBe(true);
    });

    it('bounds a 120-link page at MAX_LINKS while counting every link found', () => {
      const anchors = Array.from(
        { length: 120 },
        (_, n) => `<p><a href="/item-${n}">Item ${n}</a></p>`,
      );
      const analysis = analyzeWithoutArticle(documentWith(anchors.join('')));
      expect(analysis.links).toHaveLength(MAX_LINKS);
      expect(analysis.coverage.links?.found).toBe(120);
      expect(analysis.coverage.links?.shown).toBe(MAX_LINKS);
      const byKind = Object.values(analysis.coverage.links?.by_kind ?? {});
      expect(byKind.reduce((sum, count) => sum + count, 0)).toBe(120);
      expect(analysis.coverage.omitted).toContainEqual({ id: 'links-beyond-limit', count: 80 });
    });

    it('reports no links as a not_found fact', () => {
      const analysis = analyzeWithoutArticle(documentWith('<p>No links here.</p>'));
      expect(analysis.links).toEqual([]);
      expect(analysis.coverage.not_found).toContain('no followable links');
      expect(analysis.coverage.links).toBeUndefined();
    });
  });

  describe('isUrlVariant', () => {
    it.each([
      ['query added', 'https://s.test/a/b', 'https://s.test/a/b?x=1', true],
      ['query changed', 'https://s.test/a/b?x=1', 'https://s.test/a/b?x=2', true],
      ['query removed', 'https://s.test/a/b?x=1', 'https://s.test/a/b', true],
      ['one segment longer', 'https://s.test/a/b', 'https://s.test/a/b/c', true],
      ['sibling segment', 'https://s.test/a/b', 'https://s.test/a/z', true],
      ['identical', 'https://s.test/a/b', 'https://s.test/a/b', false],
      ['different origin', 'https://s.test/a/b', 'https://t.test/a/b?x=1', false],
      ['different scheme', 'https://s.test/a/b', 'http://s.test/a/b?x=1', false],
      ['two segments longer', 'https://s.test/a/b', 'https://s.test/a/b/c/d', false],
      ['unrelated path', 'https://s.test/a/b', 'https://s.test/q/r', false],
      ['root sibling', 'https://s.test/', 'https://s.test/x', true],
      ['unparseable', 'https://s.test/a', 'not a url', false],
    ])('%s', (_name, page, candidate, expected) => {
      expect(isUrlVariant(page, candidate)).toBe(expected);
    });
  });

  it('documents the pagination vocabulary as generic words and glyphs', () => {
    expect([...PAGINATION_WORDS]).toEqual([
      'next',
      'previous',
      'prev',
      'older',
      'newer',
      '»',
      '›',
      '«',
      '‹',
    ]);
  });
});
