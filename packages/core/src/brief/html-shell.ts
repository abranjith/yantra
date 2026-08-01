/**
 * Shared inert HTML shell for Briefs and templated reports.
 *
 * All model/web-derived Markdown is escaped before it reaches
 * {@link hardenedMarkdown}; links survive only for http(s), images collapse to
 * inert alt text, and the shell contains no scripts or remote assets.
 */

import { Marked } from 'marked';

/** Return an http(s) URL unchanged, or null for every other scheme. */
export function safeHref(url: string): string | null {
  return /^https?:\/\//iu.test(url) ? url : null;
}

/** HTML-escape a string for element-content and quoted-attribute contexts. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;');
}

/** Stateless GFM parser with scheme-filtered links and disabled remote images. */
export const hardenedMarkdown = new Marked({ gfm: true });
hardenedMarkdown.use({
  renderer: {
    link(token): string {
      const text = this.parser.parseInline(token.tokens);
      const href = safeHref(String(token.href ?? ''));
      if (href === null) return text;
      return `<a href="${escapeHtml(href)}" rel="noopener noreferrer">${text}</a>`;
    },
    image(token): string {
      return escapeHtml(String(token.text ?? ''));
    },
  },
});

/** Wrap already-rendered inert body HTML in the self-contained document theme. */
export function inertDocument(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
${THEME_CSS}
</style>
</head>
<body>
<main class="brief">
${body}
</main>
</body>
</html>
`;
}

/** Inlined, framework-free theme with no remote fonts or assets. */
const THEME_CSS = `:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 2rem 1rem;
  font-family: Georgia, "Times New Roman", serif;
  line-height: 1.6;
  color: #1a1a1a;
  background: #fafaf8;
}
.brief { max-width: 46rem; margin: 0 auto; }
h1 { font-size: 1.9rem; line-height: 1.2; margin: 0 0 1rem; }
h2 {
  font-size: 1.3rem;
  margin: 2rem 0 0.5rem;
  padding-bottom: 0.25rem;
  border-bottom: 1px solid #e0ddd5;
}
a { color: #1256a3; }
.overview {
  background: #fff;
  border: 1px solid #e0ddd5;
  border-left: 4px solid #1256a3;
  border-radius: 6px;
  padding: 0.75rem 1.25rem;
  margin: 1rem 0 1.5rem;
  font-size: 1.05rem;
}
.overview p:first-child { margin-top: 0; }
.overview p:last-child { margin-bottom: 0; }
table.comparison, section table {
  border-collapse: collapse;
  width: 100%;
  margin: 0.5rem 0 1rem;
  font-family: -apple-system, Segoe UI, Roboto, sans-serif;
  font-size: 0.95rem;
}
table.comparison th, table.comparison td, section table th, section table td {
  text-align: left;
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid #e0ddd5;
}
table.comparison thead th, section table thead th { border-bottom: 2px solid #cfc9bd; }
table.comparison tbody tr:nth-child(even), section table tbody tr:nth-child(even) { background: #f2efe9; }
ol.sources { padding-left: 1.5rem; }
ol.sources li { margin: 0.35rem 0; }
.src-meta { color: #6b675e; font-size: 0.85rem; }
blockquote.src-excerpt {
  margin: 0.25rem 0 0;
  padding: 0.1rem 0 0.1rem 0.75rem;
  border-left: 3px solid #e0ddd5;
  color: #4c4942;
  font-size: 0.9rem;
}
ul.key-findings { padding-left: 1.5rem; }
ul.key-findings li { margin: 0.35rem 0; }
ul.children {
  margin: 0.35rem 0 0;
  padding-left: 1.25rem;
  color: #4c4942;
}
ul.children li { margin: 0.2rem 0; }
sup.cite { font-size: 0.7em; margin-left: 1px; line-height: 0; }
sup.cite a, sup.cite span { color: #8a8578; text-decoration: none; }
sup.cite a:hover { text-decoration: underline; color: #1256a3; }
ul.notices {
  list-style: none;
  padding: 0;
  margin: 0.5rem 0;
}
ul.notices li {
  background: #fff8e6;
  border: 1px solid #eadfb8;
  border-radius: 4px;
  padding: 0.4rem 0.75rem;
  margin: 0.35rem 0;
  font-size: 0.9rem;
}`;
