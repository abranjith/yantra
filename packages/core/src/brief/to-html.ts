/**
 * Brief-only composition over the shared inert machinery in `html-shell.ts`.
 * The extraction lets templated reports use the identical escape-before-parse
 * and scheme-filtered document shell without changing Brief output.
 *
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
 *   verbatim, so escaping first (not sanitizing after) is the guarantee. On the
 *   Markdown path the escape is `escapeForMarkdown`, which still encodes `<`
 *   (no tag can open without it) but leaves `>` so blockquotes keep working.
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

import {
  editorialMarkIsInformative,
  type Brief,
  type BriefNotice,
  type BriefSource,
  type KeyFinding,
  type Section,
} from '@yantra/protocol';

import {
  escapeForMarkdown,
  escapeHtml,
  hardenedMarkdown,
  inertDocument,
  safeHref,
} from './html-shell.js';

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

  return inertDocument(brief.title, body.join('\n'));
}

/** Renders a Brief Markdown field to inert HTML (fields escaped pre-parse). */
function renderMarkdown(text: string): string {
  return (hardenedMarkdown.parse(escapeForMarkdown(text)) as string).trim();
}

/** Renders a Brief field as inline HTML (no block wrapper), escaped pre-parse. */
function renderInline(text: string): string {
  return (hardenedMarkdown.parseInline(escapeForMarkdown(text)) as string).trim();
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
  // The editorial chip is shown only when it separates commentary from cited
  // findings; an all-editorial Brief would otherwise chip every bullet.
  const markEditorial = editorialMarkIsInformative(findings);
  const items = findings
    .map((finding) => {
      const editorial =
        markEditorial && finding.editorial ? ' <em class="editorial">editorial</em>' : '';
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
  // The wrapper matches what the Markdown table renderer emits, so a wide
  // comparison scrolls in its own box instead of stretching the page.
  return `<div class="table-wrap">\n<table class="comparison">\n<thead><tr>${head}</tr></thead>\n<tbody>\n${rows}\n</tbody>\n</table>\n</div>`;
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
      const meta = [
        `<span class="src-host">${escapeHtml(source.host)}</span>`,
        timestamp('fetched', source.fetched_at),
      ];
      if (source.published_at !== null) {
        meta.push(timestamp('published', source.published_at));
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

/**
 * Renders an ISO-8601 timestamp as a readable date, keeping the full instant in
 * the machine-readable `datetime` attribute. A value that is not ISO-shaped
 * (possible for a Brief read from disk without a schema re-parse) falls back to
 * escaped text rather than emitting an invalid `<time>`.
 */
function timestamp(label: string, iso: string): string {
  const day = /^\d{4}-\d{2}-\d{2}/u.exec(iso);
  if (day === null) {
    return `${label} ${escapeHtml(iso)}`;
  }
  return `${label} <time datetime="${escapeHtml(iso)}">${escapeHtml(day[0])}</time>`;
}

/**
 * Visual severity per notice kind, driving the colour and glyph of the notice
 * card. Unknown kinds (a Brief written by a newer schema) degrade to `info`.
 */
const NOTICE_SEVERITY: Readonly<Record<BriefNotice['kind'], 'danger' | 'warn' | 'info'>> = {
  fetch_failed: 'warn',
  extract_failed: 'warn',
  blocked: 'danger',
  source_excluded: 'info',
  uncited_claim_stripped: 'danger',
  uncited_claim_flagged: 'warn',
  budget_exhausted: 'warn',
  limited_evidence: 'warn',
  other: 'info',
};

/** The honest notices block as an escaped, severity-coded list. */
function noticesHtml(notices: Brief['notices']): string {
  const items = notices
    .map((notice) => {
      const severity = NOTICE_SEVERITY[notice.kind] ?? 'info';
      // `fetch_failed` reads as machinery; `fetch failed` reads as English.
      const kind = escapeHtml(notice.kind.replace(/_/gu, ' '));
      return `<li class="notice--${severity}"><span><strong class="notice-kind">${kind}</strong> — ${escapeHtml(
        notice.source,
      )}: ${escapeHtml(notice.reason)}</span></li>`;
    })
    .join('\n');
  return `<ul class="notices">\n${items}\n</ul>`;
}

/** Formats a facet scalar for a table cell. */
function cell(value: string | number | boolean | null): string {
  if (value === null) {
    // An em dash reads as "no value here"; an empty cell reads as a bug.
    return '<span class="nil">—</span>';
  }
  if (typeof value === 'boolean') {
    return value ? '<span class="yes">✓</span>' : '<span class="no">✗</span>';
  }
  return escapeHtml(String(value));
}
