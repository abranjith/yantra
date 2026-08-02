/**
 * Shared inert HTML shell for Briefs and templated reports.
 *
 * All model/web-derived Markdown is escaped before it reaches
 * {@link hardenedMarkdown}; links survive only for http(s), images collapse to
 * inert alt text, and the shell contains no scripts or remote assets.
 *
 * ## Escape-before-parse and the double-escape hazard
 *
 * Callers escape every untrusted field with {@link escapeForMarkdown} *before*
 * handing it to the parser, so no live tag can ever reach the output (`<` is
 * always encoded; see that function for why `>` is not). The consequence is
 * that by the time `marked` sees the text it already contains entities
 * (`&lt;`, `&amp;`), and `marked`'s own escaping would encode those a second
 * time — `&lt;` becoming `&amp;lt;`, which the browser then shows literally.
 * Every renderer that emits text verbatim (code, code spans, image alt text,
 * link hrefs) therefore uses {@link escapeHtmlOnce}, which escapes the
 * tag-forming characters but leaves well-formed entities intact. That is
 * idempotent, so it is still safe if a caller ever passes unescaped input.
 */

import { Marked, Renderer } from 'marked';

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

/**
 * Escape untrusted text that is about to be parsed as Markdown.
 *
 * Identical to {@link escapeHtml} except that `>` is left alone. A tag needs
 * `<` to open, and that is still escaped, so no markup can form — but `>` is
 * also Markdown's blockquote marker, and encoding it up front silently broke
 * every `> quoted line` in a Brief section or report body. `marked` escapes any
 * `>` that survives as literal text, so the emitted HTML stays well-formed.
 *
 * Use this only on the Markdown path. Values assembled straight into HTML
 * (attributes, hand-built elements) must still go through {@link escapeHtml}.
 */
export function escapeForMarkdown(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;');
}

/** Matches an already well-formed named, decimal, or hex character reference. */
const ENTITY = /&(?!(?:#\d+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});)/gu;

/**
 * HTML-escape a string that may already contain entities, without encoding them
 * twice.
 *
 * Identical to {@link escapeHtml} except that a `&` which already opens a valid
 * character reference is left alone. Use this for values that have been escaped
 * once already — anything read back off a Markdown token, since the source text
 * went through {@link escapeForMarkdown} before the parse. Use
 * {@link escapeHtml} for raw, never-escaped input.
 */
export function escapeHtmlOnce(value: string): string {
  return value
    .replace(ENTITY, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;');
}

/** Fence info strings we are willing to echo back as a `language-*` class. */
const SAFE_LANGUAGE = /^[A-Za-z0-9_+.#-]{1,32}$/u;

/** Escaped `<br>` variants our own table renderer re-authorizes (see below). */
const ESCAPED_BR = /&lt;br\s*\/?&gt;/giu;

/** Default renderer, delegated to for the block scaffolding we do not change. */
const BASE_RENDERER = new Renderer();

/** Stateless GFM parser with scheme-filtered links and disabled remote images. */
export const hardenedMarkdown = new Marked({ gfm: true });
hardenedMarkdown.use({
  renderer: {
    link(token): string {
      const text = this.parser.parseInline(token.tokens);
      const href = safeHref(String(token.href ?? ''));
      if (href === null) return text;
      return `<a href="${escapeHtmlOnce(href)}" rel="noopener noreferrer">${text}</a>`;
    },
    image(token): string {
      // Remote loads are forbidden, so an image degrades to its alt text —
      // marked as such, so a reader is not left wondering what went missing.
      const alt = escapeHtmlOnce(String(token.text ?? '')).trim();
      return alt.length === 0 ? '' : `<span class="img-alt" title="image omitted">${alt}</span>`;
    },
    code(token): string {
      const info = String(token.lang ?? '').split(/\s+/u)[0] ?? '';
      const language = SAFE_LANGUAGE.test(info) ? ` class="language-${info}"` : '';
      const body = escapeHtmlOnce(String(token.text ?? '')).replace(/\n+$/u, '');
      return `<pre><code${language}>${body}\n</code></pre>\n`;
    },
    codespan(token): string {
      return `<code>${escapeHtmlOnce(String(token.text ?? ''))}</code>`;
    },
    table(token): string {
      // Wide tables scroll inside their own box instead of stretching the page.
      return `<div class="table-wrap">\n${BASE_RENDERER.table.call(this, token)}</div>\n`;
    },
    tablecell(token): string {
      // A hard line break is the only way GFM can express a multi-line table
      // cell, and our own Markdown writers emit it (see `renderTemplate`). This
      // re-authorizes exactly that one attribute-free void tag, inside table
      // cells only — it can carry no URL, handler, or content, so it adds no
      // executable vector.
      return BASE_RENDERER.tablecell.call(this, token).replace(ESCAPED_BR, '<br>');
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
<meta name="referrer" content="no-referrer">
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

/**
 * Inlined, framework-free theme — self-contained, no remote fonts or assets.
 *
 * One token palette drives both schemes: the light values live on `:root` and
 * `prefers-color-scheme: dark` restates the same names, so every component rule
 * below is written once and is correct in either scheme (and in print, which
 * restates them a third time so a dark-mode reader does not print dark pages).
 */
const THEME_CSS = `/* ---------- tokens ---------- */
:root {
  color-scheme: light dark;
  --ui: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  --bg: #f6f4ef;
  --surface: #fffdf8;
  --surface-alt: #f0ece3;
  --ink: #1c1b18;
  --ink-soft: #4d4a43;
  --ink-faint: #7d786c;
  --rule: #e2ddd1;
  --rule-strong: #cbc4b4;
  --accent: #1a5fb4;
  --accent-soft: #e7eefa;
  --warm: #b0541b;
  --ok: #1f7a4d;
  --warn: #8a6206;
  --warn-soft: #fbf1d6;
  --danger: #b3261e;
  --danger-soft: #fbe7e5;
  --radius: 8px;
  --shadow: 0 1px 2px rgba(28, 27, 24, 0.05), 0 10px 24px -18px rgba(28, 27, 24, 0.45);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #15161a;
    --surface: #1d1f25;
    --surface-alt: #24272f;
    --ink: #e9e7e2;
    --ink-soft: #b5b1a8;
    --ink-faint: #8a8579;
    --rule: #2f333c;
    --rule-strong: #464c58;
    --accent: #7fb2f0;
    --accent-soft: #1a2c42;
    --warm: #e59a63;
    --ok: #62c58c;
    --warn: #e0b95f;
    --warn-soft: #322a15;
    --danger: #f08a80;
    --danger-soft: #3a1e1c;
    --shadow: 0 1px 2px rgba(0, 0, 0, 0.4), 0 10px 24px -18px rgba(0, 0, 0, 0.9);
  }
}

/* ---------- base ---------- */
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body {
  margin: 0;
  padding: 2.5rem 1.25rem 4rem;
  font-family: Georgia, "Iowan Old Style", "Times New Roman", serif;
  font-size: 1.05rem;
  line-height: 1.65;
  color: var(--ink);
  background: var(--bg);
  -webkit-text-size-adjust: 100%;
}
body::before {
  content: "";
  position: fixed;
  inset: 0 0 auto 0;
  height: 3px;
  background: linear-gradient(90deg, var(--accent), var(--warm));
}
::selection { background: var(--accent-soft); color: var(--ink); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 3px; }
.brief { max-width: 46rem; margin: 0 auto; }

/* ---------- typography ---------- */
h1 {
  font-size: clamp(1.75rem, 1.2rem + 2vw, 2.3rem);
  line-height: 1.15;
  letter-spacing: -0.01em;
  margin: 0 0 0.75rem;
}
h1::after {
  content: "";
  display: block;
  width: 3.5rem;
  height: 3px;
  margin-top: 0.7rem;
  border-radius: 2px;
  background: linear-gradient(90deg, var(--accent), var(--warm));
}
h2 {
  font-size: 1.35rem;
  margin: 2.25rem 0 0.6rem;
  padding-bottom: 0.3rem;
  border-bottom: 1px solid var(--rule);
}
h3 { font-size: 1.12rem; margin: 1.6rem 0 0.4rem; }
h4, h5, h6 {
  font-family: var(--ui);
  font-size: 0.9rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--ink-soft);
  margin: 1.5rem 0 0.35rem;
}
p { margin: 0 0 1rem; }
ul, ol { padding-left: 1.4rem; margin: 0 0 1rem; }
li { margin: 0.3rem 0; }
li::marker { color: var(--ink-faint); }
ul:has(> li > input[type="checkbox"]) { list-style: none; padding-left: 0.25rem; }
input[type="checkbox"] { accent-color: var(--accent); margin-right: 0.4rem; }
hr { border: 0; height: 1px; background: var(--rule); margin: 2rem 0; }
del { color: var(--ink-faint); }
mark { background: var(--warn-soft); color: var(--ink); padding: 0 0.15em; border-radius: 3px; }
a { color: var(--accent); text-decoration-thickness: 1px; text-underline-offset: 2px; }
a:hover { color: var(--warm); }
blockquote {
  margin: 1rem 0;
  padding: 0.5rem 1rem;
  border-left: 3px solid var(--rule-strong);
  border-radius: 0 var(--radius) var(--radius) 0;
  background: var(--surface-alt);
  color: var(--ink-soft);
}
blockquote p:first-child { margin-top: 0; }
blockquote p:last-child { margin-bottom: 0; }
code {
  font-family: var(--mono);
  font-size: 0.87em;
  background: var(--surface-alt);
  border: 1px solid var(--rule);
  border-radius: 4px;
  padding: 0.05em 0.35em;
}
pre {
  font-family: var(--mono);
  background: var(--surface-alt);
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  padding: 0.9rem 1.1rem;
  margin: 0 0 1.1rem;
  line-height: 1.5;
  overflow-x: auto;
}
pre code { background: none; border: 0; padding: 0; font-size: 0.85em; }
.img-alt {
  font-family: var(--ui);
  font-size: 0.85em;
  color: var(--ink-faint);
  border: 1px dashed var(--rule-strong);
  border-radius: 4px;
  padding: 0.05em 0.4em;
}

/* ---------- overview ---------- */
.overview {
  background: var(--surface);
  border: 1px solid var(--rule);
  border-left: 4px solid var(--accent);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  padding: 1rem 1.35rem 1.05rem;
  margin: 1.25rem 0 1.75rem;
  font-size: 1.07rem;
}
.overview::before {
  content: "In short";
  display: block;
  font-family: var(--ui);
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--warm);
  margin-bottom: 0.4rem;
}
.overview p:last-child { margin-bottom: 0; }

/* ---------- key findings ---------- */
ul.key-findings { list-style: none; padding-left: 0; }
ul.key-findings > li { position: relative; padding-left: 1.4rem; margin: 0.55rem 0; }
ul.key-findings > li::before {
  content: "";
  position: absolute;
  left: 0.2rem;
  top: 0.68em;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
}
ul.children {
  list-style: none;
  margin: 0.4rem 0 0;
  padding-left: 0.85rem;
  border-left: 2px solid var(--rule);
  color: var(--ink-soft);
  font-size: 0.95em;
}
ul.children li { margin: 0.2rem 0; padding-left: 0.5rem; }
em.editorial {
  font-family: var(--ui);
  font-style: normal;
  font-size: 0.72em;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--warm);
  background: var(--surface-alt);
  border: 1px solid var(--rule);
  border-radius: 999px;
  padding: 0.1em 0.5em;
  margin-left: 0.35em;
  white-space: nowrap;
}

/* ---------- citations ---------- */
sup.cite { font-size: 0.68em; line-height: 0; margin-left: 2px; }
sup.cite a, sup.cite span {
  text-decoration: none;
  border-radius: 4px;
  padding: 0.2em 0.35em;
  transition: background-color 120ms ease, color 120ms ease;
}
sup.cite a { color: var(--accent); background: var(--accent-soft); }
sup.cite a:hover { color: var(--surface); background: var(--accent); }
sup.cite span { color: var(--ink-faint); background: var(--surface-alt); cursor: help; }

/* ---------- tables ---------- */
.table-wrap { overflow-x: auto; margin: 0.75rem 0 1.25rem; }
.brief table {
  border-collapse: collapse;
  width: 100%;
  font-family: var(--ui);
  font-size: 0.92rem;
  background: var(--surface);
}
.brief th, .brief td {
  text-align: left;
  vertical-align: top;
  padding: 0.55rem 0.8rem;
  border-bottom: 1px solid var(--rule);
}
.brief td { font-variant-numeric: tabular-nums; }
.brief thead th {
  background: var(--surface-alt);
  color: var(--ink-soft);
  font-size: 0.78rem;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  white-space: nowrap;
  border-bottom: 2px solid var(--rule-strong);
}
.brief tbody tr { transition: background-color 120ms ease; }
.brief tbody tr:nth-child(even) { background: var(--surface-alt); }
.brief tbody tr:hover { background: var(--accent-soft); }
.brief tbody tr:last-child td { border-bottom: 0; }
.brief td .yes { color: var(--ok); font-weight: 700; }
.brief td .no { color: var(--danger); }
.brief td .nil { color: var(--ink-faint); }

/* ---------- sources ---------- */
ol.sources { padding-left: 1.7rem; }
ol.sources li {
  margin: 0.6rem 0;
  padding: 0.15rem 0.3rem;
  border-radius: 4px;
  scroll-margin-top: 2rem;
  transition: background-color 200ms ease;
}
ol.sources li::marker {
  font-family: var(--ui);
  font-size: 0.85em;
  font-variant-numeric: tabular-nums;
  color: var(--accent);
}
ol.sources li:target { background: var(--accent-soft); box-shadow: 0 0 0 0.35rem var(--accent-soft); }
ol.sources a, .src-title { overflow-wrap: anywhere; }
.src-meta {
  font-family: var(--ui);
  font-size: 0.8rem;
  color: var(--ink-faint);
  white-space: nowrap;
}
.src-host { color: var(--ink-soft); }
.src-meta time { font-variant-numeric: tabular-nums; }
blockquote.src-excerpt {
  margin: 0.3rem 0 0;
  padding: 0.15rem 0 0.15rem 0.75rem;
  border-left: 3px solid var(--rule);
  border-radius: 0;
  background: none;
  color: var(--ink-soft);
  font-size: 0.9rem;
  font-style: italic;
}

/* ---------- notices ---------- */
ul.notices { list-style: none; padding: 0; margin: 0.6rem 0; }
ul.notices li {
  display: flex;
  gap: 0.6rem;
  align-items: flex-start;
  background: var(--surface);
  border: 1px solid var(--rule);
  border-left: 4px solid var(--ink-faint);
  border-radius: var(--radius);
  padding: 0.55rem 0.9rem;
  margin: 0.4rem 0;
  font-family: var(--ui);
  font-size: 0.88rem;
  color: var(--ink-soft);
}
ul.notices li::before {
  content: "i";
  flex: none;
  display: grid;
  place-items: center;
  width: 1.15rem;
  height: 1.15rem;
  margin-top: 0.12rem;
  border-radius: 50%;
  background: var(--ink-faint);
  color: var(--surface);
  font-size: 0.72rem;
  font-weight: 700;
}
ul.notices li.notice--info { border-left-color: var(--accent); background: var(--accent-soft); }
ul.notices li.notice--info::before { background: var(--accent); }
ul.notices li.notice--warn { border-left-color: var(--warn); background: var(--warn-soft); }
ul.notices li.notice--warn::before { content: "!"; background: var(--warn); }
ul.notices li.notice--danger { border-left-color: var(--danger); background: var(--danger-soft); }
ul.notices li.notice--danger::before { content: "!"; background: var(--danger); }
.notice-kind { color: var(--ink); }

/* ---------- narrow screens ---------- */
@media (max-width: 34rem) {
  body { padding: 1.75rem 0.9rem 3rem; font-size: 1rem; }
  h2 { margin-top: 1.75rem; }
  .overview { padding: 0.85rem 1rem; }
  .src-meta { white-space: normal; }
}

@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  * { transition: none !important; }
}

/* ---------- print ---------- */
@media print {
  :root {
    --bg: #ffffff;
    --surface: #ffffff;
    --surface-alt: #f4f2ed;
    --ink: #111111;
    --ink-soft: #3a3a3a;
    --ink-faint: #5a5a5a;
    --rule: #cccccc;
    --rule-strong: #999999;
    --accent: #0b4a8f;
    --accent-soft: #eef3fb;
    --shadow: none;
  }
  body { padding: 0; font-size: 11pt; }
  body::before { display: none; }
  .brief { max-width: none; }
  .table-wrap { overflow: visible; }
  ol.sources a[href^="http"]::after {
    content: " (" attr(href) ")";
    font-size: 0.8em;
    color: var(--ink-faint);
    word-break: break-all;
  }
  h1, h2, h3 { break-after: avoid; }
  pre, blockquote, .table-wrap, ol.sources li, ul.notices li { break-inside: avoid; }
}`;
