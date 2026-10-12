/**
 * Small, deterministic HTML helpers shared by the task-fidelity renderers.
 *
 * No templating library: a fixture page must be readable as the markup it
 * serves, and every byte must be a pure function of the truth dataset.
 */

/** Escape text for an HTML text node or a double-quoted attribute. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** One rendered fixture response. */
export interface RenderedPage {
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
}

export const HTML_CONTENT_TYPE = 'text/html; charset=utf-8';

/**
 * The leading header comment every fixture page starts with.
 *
 * It is the only place provenance (the run and gap identifiers that motivated
 * the pattern) may appear; the census asserts that nothing outside it repeats
 * that text.
 */
export function headerComment(name: string, pattern: string, provenance: string): string {
  return `<!-- task-fidelity fixture "${name}": ${pattern} Provenance: ${provenance}. -->`;
}

/** A complete HTML document: header comment, doctype, head, and body. */
export function htmlDocument(input: {
  readonly header: string;
  readonly title: string;
  readonly head?: string;
  readonly body: string;
}): string {
  return [
    input.header,
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    `<title>${escapeHtml(input.title)}</title>`,
    ...(input.head === undefined ? [] : [input.head]),
    '</head>',
    '<body>',
    input.body,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/**
 * A site's home page: a heading, one sentence, and navigation links to the
 * site's main pages — what a model lands on when it opens the bare host.
 */
export function homePage(input: {
  readonly header: string;
  readonly title: string;
  readonly intro: string;
  readonly links: readonly { readonly href: string; readonly text: string }[];
}): RenderedPage {
  return htmlPage(
    htmlDocument({
      header: input.header,
      title: input.title,
      body: [
        '<header>',
        '<nav aria-label="Site">',
        ...input.links.map(
          (link) => `<a href="${escapeHtml(link.href)}">${escapeHtml(link.text)}</a>`,
        ),
        '</nav>',
        '</header>',
        '<main>',
        `<h1>${escapeHtml(input.title)}</h1>`,
        `<p>${escapeHtml(input.intro)}</p>`,
        '<ul>',
        ...input.links.map(
          (link) => `<li><a href="${escapeHtml(link.href)}">${escapeHtml(link.text)}</a></li>`,
        ),
        '</ul>',
        '</main>',
      ].join('\n'),
    }),
  );
}

/** A 200 HTML response. */
export function htmlPage(body: string): RenderedPage {
  return { status: 200, contentType: HTML_CONTENT_TYPE, body };
}

/** A short lowercase slug (`Northgate Motor Co.` → `northgate-motor-co`). */
export function slugOf(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-|-$/g, '');
}
