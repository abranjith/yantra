/**
 * `article`: long-form prose with a byline and a `datePublished` JSON-LD block.
 *
 * The pattern: a single article inside `<article>`, surrounded by site chrome,
 * the shape today's Readability path was built for. The deterministic tier pins
 * its extracted text byte for byte, so a change to extraction that alters the
 * article path is caught immediately (plan §7, "article path unchanged").
 */

import {
  ARTICLE_AUTHOR,
  ARTICLE_PUBLISHED,
  ARTICLE_SECTIONS,
  ARTICLE_TITLE,
} from './article-corpus.js';
import {
  escapeHtml,
  headerComment,
  homePage,
  htmlDocument,
  htmlPage,
  type RenderedPage,
} from './html.js';

export const ARTICLE_PATTERN =
  'A single long-form article with a byline and a published date in structured data, inside site chrome.';
export const ARTICLE_PROVENANCE = { gaps: ['G2'] } as const;

/** The article's path. */
export const ARTICLE_PATH = '/guides/home-backup-battery-sizing';

/** Every page the site serves, as `path?query`. */
export const ARTICLE_ROUTES: readonly string[] = Object.freeze([
  '/',
  '/guides',
  '/about',
  ARTICLE_PATH,
]);

/**
 * Render one `article` route, or null for an unknown path: the article, plus
 * the home, guide-index, and about pages its navigation links to.
 *
 * @param path URL pathname.
 * @param _query URL search parameters (unused).
 */
export function renderArticle(path: string, _query: URLSearchParams): RenderedPage | null {
  if (path === ARTICLE_PATH) return htmlPage(articlePage());
  const header = headerComment(
    'article',
    ARTICLE_PATTERN,
    `gaps ${ARTICLE_PROVENANCE.gaps.join(', ')}`,
  );
  const guides = { href: '/guides', text: 'Guides' };
  const article = { href: ARTICLE_PATH, text: ARTICLE_TITLE };
  if (path === '/') {
    return homePage({
      header,
      title: 'Home energy guides',
      intro: 'Practical guides.',
      links: [guides, article],
    });
  }
  if (path === '/guides') {
    return homePage({
      header,
      title: 'Guides',
      intro: 'All guides, newest first.',
      links: [article],
    });
  }
  if (path === '/about') {
    return homePage({
      header,
      title: 'About',
      intro: 'Guides are written for general information and are not professional advice.',
      links: [guides],
    });
  }
  return null;
}

function articlePage(): string {
  const metadata = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: ARTICLE_TITLE,
    author: { '@type': 'Person', name: ARTICLE_AUTHOR },
    datePublished: ARTICLE_PUBLISHED,
  };
  const sections = ARTICLE_SECTIONS.flatMap((section) => [
    ...(section.heading === null ? [] : [`<h2>${escapeHtml(section.heading)}</h2>`]),
    ...section.paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`),
  ]);
  return htmlDocument({
    header: headerComment('article', ARTICLE_PATTERN, `gaps ${ARTICLE_PROVENANCE.gaps.join(', ')}`),
    title: ARTICLE_TITLE,
    head: `<script type="application/ld+json">\n${JSON.stringify(metadata, null, 2)}\n</script>`,
    body: [
      '<header>',
      '<nav aria-label="Site"><a href="/">Home</a> <a href="/guides">Guides</a> <a href="/about">About</a></nav>',
      '</header>',
      '<main>',
      '<article>',
      `<h1>${escapeHtml(ARTICLE_TITLE)}</h1>`,
      `<p class="byline">By <span rel="author">${escapeHtml(ARTICLE_AUTHOR)}</span> · <time datetime="${ARTICLE_PUBLISHED}">March 14, 2026</time></p>`,
      ...sections,
      '</article>',
      '<aside aria-label="Related"><h2>Related guides</h2><ul><li><a href="/guides">All guides</a></li></ul></aside>',
      '</main>',
      '<footer><p>Guides are written for general information and are not professional advice.</p></footer>',
    ].join('\n'),
  });
}
