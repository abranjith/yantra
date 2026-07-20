/**
 * `briefToHtml` — the inert, self-contained `brief.html` artifact renderer.
 *
 * ## Inertness contract (plan §6, FEAT-015 TASK-003)
 *
 * `brief.html` is generated from Brief content that ultimately derives from
 * untrusted web pages. It MUST be safe to open in a browser and share:
 *
 * - **No executable vectors.** Every Brief string field is HTML-escaped *at
 *   assembly* — before it enters the Markdown→HTML path — so a source that
 *   smuggled `<script>`, `<img onerror=…>`, or `<svg onload=…>` renders as
 *   inert text, never as a live tag. `marked` passes raw HTML through
 *   verbatim, so escaping first (not sanitizing after) is the guarantee.
 * - **No dangerous URLs.** Links are scheme-filtered: only `http:`/`https:`
 *   hrefs survive (as real anchors carrying `rel="noopener noreferrer"`);
 *   `javascript:`, `data:`, and everything else collapse to plain text. This
 *   covers both the numbered source links and any link the synthesizer placed
 *   inside `overview`/`body_md` Markdown.
 * - **No remote loads, no JS.** The document is fully self-contained: one
 *   inlined `<style>` theme, `<meta charset>`, and zero `<script>`, `<link>`,
 *   or `<img>` elements. The only external references are the source
 *   hyperlinks the reader deliberately clicks.
 * - **Subtle citations stay inert.** Findings render their structured
 *   `citations[]`, and inline `[n]` marker runs in already-escaped prose are
 *   rewritten (`subtleizeCitations`), into small muted `<sup>` superscripts.
 *   The transform only ever emits `sup`/`a`/`span`, every anchor is an internal
 *   `#src-n` fragment, and every value is digits-only — so it introduces no new
 *   executable vector. It also skips whole tags, so a `[n]` inside an attribute
 *   value is never touched. Hover reveals the collapsed `+k` remainder with no
 *   JavaScript.
 * - **Section tables share the comparison styling.** GFM key-figures tables
 *   remain escape-before-parse inert and use the same readable striped theme.
 *
 * ## Purity
 *
 * `Brief → string` with no I/O, clock, or randomness — snapshot-safe and
 * deterministic, exactly like {@link briefToMarkdown}.
 */

import type { Brief, BriefSource, KeyFinding, Section } from '@yantra/protocol';
import { Marked } from 'marked';

/**
 * A Markdown renderer whose only override is a hardened link renderer: it
 * drops any non-`http(s)` href to plain text and stamps `rel` on the rest.
 * Constructed once (pure, stateless) and reused across calls.
 */
const markdown = new Marked({ gfm: true });
markdown.use({
  renderer: {
    link(token): string {
      // `token.tokens` is the already-escaped link text (fields are escaped
      // before parsing), so parseInline cannot reintroduce markup.
      const text = this.parser.parseInline(token.tokens);
      const href = safeHref(String(token.href ?? ''));
      if (href === null) {
        return text;
      }
      return `<a href="${escapeHtml(href)}" rel="noopener noreferrer">${text}</a>`;
    },
  },
});

/**
 * Renders a {@link Brief} as a self-contained, inert HTML document.
 *
 * @param brief - A fully-formed, schema-valid Brief.
 * @returns The complete `brief.html` contents (with trailing newline).
 *
 * @example
 * const html = briefToHtml(brief);
 * await writeFile('brief.html', html, 'utf8');
 * // <!DOCTYPE html> … fully inlined, no <script>, safe to open.
 */
export function briefToHtml(brief: Brief): string {
  const body: string[] = [];
  // Declared source numbers — inline [n] markers only become citation links
  // when they resolve to one of these (see subtleizeCitations).
  const declared = new Set(brief.sources.map((source) => source.n));

  body.push(`<h1>${escapeHtml(brief.title)}</h1>`);

  const overview = brief.overview.trim();
  if (overview.length > 0) {
    body.push(
      `<section class="overview">${subtleizeCitations(renderMarkdown(overview), declared)}</section>`,
    );
  }

  if (brief.key_findings.length > 0) {
    body.push('<h2>Key Findings</h2>');
    body.push(keyFindingsHtml(brief.key_findings, declared));
  }

  for (const section of brief.sections) {
    body.push(sectionHtml(section, declared));
  }

  const comparison = brief.facets?.comparison ?? null;
  if (comparison !== null && comparison.rows.length > 0) {
    body.push('<h2>Comparison</h2>');
    body.push(comparisonHtml(comparison));
  }

  if (brief.sources.length > 0) {
    body.push('<h2>Sources</h2>');
    body.push(sourcesHtml(brief.sources));
  }

  if (brief.notices.length > 0) {
    body.push('<h2>Notices</h2>');
    body.push(noticesHtml(brief.notices));
  }

  return document(brief.title, body.join('\n'));
}

/** Renders a Brief Markdown field to inert HTML (fields escaped pre-parse). */
function renderMarkdown(text: string): string {
  return (markdown.parse(escapeHtml(text)) as string).trim();
}

/** Renders a Brief field as inline HTML (no block wrapper), escaped pre-parse. */
function renderInline(text: string): string {
  return (markdown.parseInline(escapeHtml(text)) as string).trim();
}

/** Max citation superscripts shown inline before collapsing to a `+k` affordance. */
const MAX_VISIBLE_CITATIONS = 3;

/**
 * Renders a citation-number list as small, muted superscript anchors, capped at
 * {@link MAX_VISIBLE_CITATIONS}. The remainder collapses into a single `+k`
 * superscript whose `title` lists the hidden sources (hover works with zero JS).
 * Every anchor is an internal `#src-n` fragment and every value is digits-only,
 * so this cannot introduce an executable vector.
 */
function citationSuperscripts(numbers: readonly number[]): string {
  if (numbers.length === 0) {
    return '';
  }
  const visible = numbers.slice(0, MAX_VISIBLE_CITATIONS);
  const overflow = numbers.slice(MAX_VISIBLE_CITATIONS);
  const anchors = visible.map((n) => `<sup class="cite"><a href="#src-${n}">${n}</a></sup>`);
  if (overflow.length > 0) {
    const title = `also sources ${overflow.join(', ')}`;
    anchors.push(
      `<sup class="cite"><span title="${escapeHtml(title)}">+${overflow.length}</span></sup>`,
    );
  }
  return anchors.join('');
}

/**
 * Post-markdown transform: rewrites inline `[n]`/`[n][m]` marker runs in already
 * rendered prose into the same muted superscripts.
 *
 * Inertness: the alternation consumes whole tags (`<[^>]*>`) first, so a `[n]`
 * that happens to sit inside an attribute value (for example a link href) is
 * never matched — only markers in text nodes are transformed. A run is left as
 * literal text unless *every* marker in it resolves to a declared source, so a
 * stray `[99]` (or a literal `[1]` in content when no source 1 exists) stays put.
 */
function subtleizeCitations(html: string, declared: ReadonlySet<number>): string {
  return html.replace(/<[^>]*>|(?:\[\d+\])+/gu, (match) => {
    if (match.startsWith('<')) {
      return match;
    }
    const numbers = [...match.matchAll(/\[(\d+)\]/gu)].map((m) => Number(m[1]));
    if (!numbers.every((n) => declared.has(n))) {
      return match;
    }
    return citationSuperscripts(numbers);
  });
}

/** The key findings as a list, each carrying its citations as subtle superscripts. */
function keyFindingsHtml(findings: readonly KeyFinding[], declared: ReadonlySet<number>): string {
  const items = findings
    .map((finding) => {
      const editorial = finding.editorial ? ' <em>(editorial)</em>' : '';
      // The deterministic path carries citations only in the structured array;
      // the LLM path may inline [n] in the text — transform those in place.
      const body = /\[\d+\]/u.test(finding.text)
        ? subtleizeCitations(renderInline(finding.text), declared)
        : `${renderInline(finding.text)}${citationSuperscripts(
            finding.citations.filter((n) => declared.has(n)),
          )}`;
      const childFindings = finding.children ?? [];
      const children =
        childFindings.length === 0
          ? ''
          : `\n<ul class="children">\n${childFindings
              .map((child) => {
                const childBody = /\[\d+\]/u.test(child.text)
                  ? subtleizeCitations(renderInline(child.text), declared)
                  : `${renderInline(child.text)}${citationSuperscripts(
                      child.citations.filter((n) => declared.has(n)),
                    )}`;
                return `<li>${childBody}</li>`;
              })
              .join('\n')}\n</ul>`;
      return `<li>${body}${editorial}${children}</li>`;
    })
    .join('\n');
  return `<ul class="key-findings">\n${items}\n</ul>`;
}

/** A detail section as an `<h2>` heading plus its rendered Markdown body. */
function sectionHtml(section: Section, declared: ReadonlySet<number>): string {
  const heading = `<h2>${escapeHtml(section.heading)}</h2>`;
  const body = section.body_md.trim();
  return body.length > 0
    ? `<section>${heading}\n${subtleizeCitations(renderMarkdown(body), declared)}</section>`
    : heading;
}

/** The comparison facet as a striped HTML table (hand-built, fully escaped). */
function comparisonHtml(
  comparison: NonNullable<NonNullable<Brief['facets']>['comparison']>,
): string {
  const head = comparison.columns.map((column) => `<th>${escapeHtml(column)}</th>`).join('');
  const rows = comparison.rows
    .map((row) => `<tr>${row.map((value) => `<td>${cell(value)}</td>`).join('')}</tr>`)
    .join('\n');
  return `<table class="comparison">\n<thead><tr>${head}</tr></thead>\n<tbody>\n${rows}\n</tbody>\n</table>`;
}

/** The numbered source list as an escaped `<ol>` with scheme-filtered links. */
function sourcesHtml(sources: readonly BriefSource[]): string {
  const items = sources
    .map((source) => {
      const label = escapeHtml(source.title ?? source.host);
      const href = safeHref(source.url);
      const link =
        href === null
          ? `<span class="src-title">${label}</span>`
          : `<a href="${escapeHtml(href)}" rel="noopener noreferrer">${label}</a>`;
      const meta = [escapeHtml(source.host), `fetched ${escapeHtml(source.fetched_at)}`];
      if (source.published_at !== null) {
        meta.push(`published ${escapeHtml(source.published_at)}`);
      }
      // typeof-guard rather than a null check: pre-excerpt Briefs read from
      // disk without a schema re-parse carry no excerpt property at all.
      const excerpt =
        typeof source.excerpt === 'string' && source.excerpt.trim().length > 0
          ? `\n<blockquote class="src-excerpt">${escapeHtml(source.excerpt)}</blockquote>`
          : '';
      // id="src-n" is the citation-superscript jump target.
      return `<li id="src-${source.n}">${link} <span class="src-meta">${meta.join(' · ')}</span>${excerpt}</li>`;
    })
    .join('\n');
  return `<ol class="sources">\n${items}\n</ol>`;
}

/** The honest notices block as an escaped list. */
function noticesHtml(notices: Brief['notices']): string {
  const items = notices
    .map(
      (notice) =>
        `<li><strong>${escapeHtml(notice.kind)}</strong> — ${escapeHtml(notice.source)}: ${escapeHtml(
          notice.reason,
        )}</li>`,
    )
    .join('\n');
  return `<ul class="notices">\n${items}\n</ul>`;
}

/** Formats a facet scalar for a table cell. */
function cell(value: string | number | boolean | null): string {
  if (value === null) {
    return '';
  }
  if (typeof value === 'boolean') {
    return value ? '✓' : '✗';
  }
  return escapeHtml(String(value));
}

/** Returns the url when it is an http(s) URL, else null (inertness gate). */
function safeHref(url: string): string | null {
  return /^https?:\/\//i.test(url) ? url : null;
}

/** HTML-escapes a string for both element-content and attribute contexts. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Wraps rendered body HTML in the full self-contained document + theme. */
function document(title: string, body: string): string {
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

/** Inlined, framework-free theme — self-contained, no remote fonts or assets. */
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
