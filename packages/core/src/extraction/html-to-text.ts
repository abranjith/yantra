/**
 * Block-aware HTML → plain-text serializer for article extraction.
 *
 * Readability's `textContent` concatenates adjacent block elements with **no
 * separator**, which glues headings, nav cards, and table cells into
 * pseudo-sentences ("Match previewsMatch previewsSee all…") that no downstream
 * splitter can deterministically repair — the HTML structure is the only place
 * the boundaries still exist. This serializer walks Readability's cleaned
 * content HTML instead and emits:
 *
 * - a blank line between block-level elements (paragraphs, divs, headings,
 *   list items, tables, …), so each becomes its own analysis block;
 * - a newline for `<br>` and between table rows/cells (cells must never glue:
 *   "CanadaMexicoUnited States" is unrecoverable downstream);
 * - nothing for `script`/`style`/`svg` and other non-content subtrees.
 *
 * The serialized text then gets a normalization pass:
 *
 * - **Consecutive duplicate blocks collapse.** Card markup commonly renders a
 *   title twice (image alt + heading); the repeat is dropped. The same
 *   collapse runs *inside* each block for adjacent repeated text runs, because
 *   responsive markup duplicates titles in sibling inline spans (e.g.
 *   Bootstrap `d-none d-md-block`), which block separation cannot see.
 * - **Footnote markers are stripped** — `[45]`, `[A]`, `[citation needed]`,
 *   `[edit]`. At extraction time bracketed number/letter groups are never the
 *   Brief's own citation markers (those are added later, at composition), so a
 *   blanket strip is safe and prevents the citation validator from mistaking
 *   source footnotes for unresolvable citations.
 * - **Character hygiene** — NBSP variants become spaces; zero-widths,
 *   variation selectors, and pictographs (emoji, ™/©-class symbols) are
 *   dropped; horizontal whitespace collapses per line.
 *
 * That normalization pass is exported on its own as
 * {@link normalizeExtractedText} for callers holding text that never was HTML
 * — a live DOM's rendered `innerText` — so every extraction path in the
 * codebase cleans its text the same way.
 *
 * Pure and deterministic: same HTML in, same text out. Never throws on
 * malformed HTML (cheerio's parser is tolerant).
 */

import { load } from 'cheerio';

/**
 * Minimal structural view of an htmlparser2 DOM node. Cheerio does not
 * re-export its node types and `domhandler` is a transitive dependency (not
 * resolvable under pnpm's isolated node_modules), so the walker types nodes
 * structurally: text nodes carry `data`, elements carry `name` + `children`,
 * and the root carries only `children`.
 */
interface DomNode {
  readonly type: string;
  readonly data?: string;
  readonly name?: string;
  readonly children?: readonly DomNode[];
}

/** Elements whose boundaries become blank lines (hard block separators). */
const BLOCK_TAGS: ReadonlySet<string> = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'dd',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'tbody',
  'tfoot',
  'thead',
  'ul',
]);

/** Table row/cell elements: separated by a single newline, never glued. */
const ROW_TAGS: ReadonlySet<string> = new Set(['tr', 'td', 'th']);

/** Non-content subtrees skipped entirely. */
const SKIP_TAGS: ReadonlySet<string> = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'iframe',
  'svg',
  'head',
  'title',
]);

/** NBSP variants normalized to a plain space. */
const NBSP_PATTERN = /[\u00a0\u2007\u202f]/gu;

/** Zero-width characters and BOM, dropped outright. */
const ZERO_WIDTH_PATTERN = /(?:\u200b|\u200c|\u200d|\ufeff)/gu;

/** Emoji-class pictographs plus variation selectors, dropped outright. */
const PICTOGRAPH_PATTERN = /[\p{Extended_Pictographic}\u{fe0e}\u{fe0f}]/gu;

/** Bracketed footnote markers: `[45]`, `[A]` (digits or a single letter). */
const FOOTNOTE_MARKER_PATTERN = /\[(?:\d{1,3}|[A-Za-z])\]/gu;

/** Named wiki-style editorial markers. */
const NAMED_MARKER_PATTERN = /\[(?:citation needed|edit|update|note \d+)\]/giu;

/**
 * Serializes HTML into block-structured plain text (see module header).
 *
 * @param html - An HTML fragment or document (typically Readability's
 *   `parsed.content`).
 * @returns Blocks separated by blank lines; empty string for empty/blank input.
 */
export function htmlToText(html: string): string {
  if (html.trim().length === 0) {
    return '';
  }

  const $ = load(html);
  const parts: string[] = [];
  // Cheerio's own node types are not exported; the structural DomNode view is
  // sufficient for a read-only walk.
  for (const node of $.root().toArray() as readonly DomNode[]) {
    serializeNode(node, parts);
  }

  return normalizeExtractedText(parts.join(''));
}

/**
 * Applies the normalization half of {@link htmlToText} to text that is already
 * plain — a browser's rendered `innerText`, for instance.
 *
 * Callers that read text out of a live DOM get the same character hygiene,
 * footnote stripping, and duplicate-block collapse as the HTML path, so a
 * fallback read and a Readability read produce comparably clean output instead
 * of each inventing its own whitespace rules.
 *
 * `\n\n` is the block separator here as it is in the serializer: `innerText`
 * already emits a blank line between block elements, so the input arrives in
 * the shape this pass expects.
 *
 * @param text - Plain text, with blank lines separating blocks.
 * @returns Normalized blocks separated by blank lines; empty string for
 *   empty/blank input.
 */
export function normalizeExtractedText(text: string): string {
  const normalized = text
    .replace(/\r\n?/gu, '\n')
    .replace(NBSP_PATTERN, ' ')
    .replace(ZERO_WIDTH_PATTERN, '')
    .replace(PICTOGRAPH_PATTERN, '')
    .replace(FOOTNOTE_MARKER_PATTERN, '')
    .replace(NAMED_MARKER_PATTERN, '');

  return collapseDuplicateBlocks(toBlocks(normalized)).join('\n\n');
}

/** Recursively serializes one DOM node into `parts`. */
function serializeNode(node: DomNode, parts: string[]): void {
  if (node.type === 'text') {
    parts.push(node.data ?? '');
    return;
  }
  if (node.type === 'comment' || node.type === 'directive' || node.type === 'cdata') {
    return;
  }

  const name = node.name?.toLowerCase();
  if (
    node.type === 'script' ||
    node.type === 'style' ||
    (name !== undefined && SKIP_TAGS.has(name))
  ) {
    return;
  }
  if (name === 'br') {
    parts.push('\n');
    return;
  }

  const separator =
    name !== undefined && ROW_TAGS.has(name)
      ? '\n'
      : name !== undefined && BLOCK_TAGS.has(name)
        ? '\n\n'
        : '';
  if (separator.length > 0) {
    parts.push(separator);
  }
  for (const child of node.children ?? []) {
    serializeNode(child, parts);
  }
  if (separator.length > 0) {
    parts.push(separator);
  }
}

/**
 * Splits serialized text into trimmed, line-normalized blocks.
 *
 * @param text - Serialized text with `\n\n` block separators.
 * @returns Non-empty blocks; within a block, lines are trimmed and
 *   horizontal whitespace is collapsed.
 */
function toBlocks(text: string): string[] {
  return text
    .split(/\n[ \t]*\n+/u)
    .map((block) =>
      block
        .split('\n')
        .map((line) => collapseAdjacentRepeats(line.replace(/[ \t]+/gu, ' ').trim()))
        .filter((line) => line.length > 0)
        .join('\n'),
    )
    .filter((block) => block.length > 0);
}

/**
 * Adjacent repeated run of ≥ 12 chars (capped so backtracking stays bounded),
 * separated by at most whitespace. Real prose essentially never repeats a
 * 12+-character span back-to-back; duplicated card titles always do.
 */
const ADJACENT_REPEAT_PATTERN = /(.{12,300}?) ?\1/u;

/** Collapses immediately-repeated text runs within one line, to fixpoint. */
function collapseAdjacentRepeats(line: string): string {
  let current = line;
  for (;;) {
    const next = current.replace(ADJACENT_REPEAT_PATTERN, '$1');
    if (next === current) {
      return current;
    }
    current = next;
  }
}

/**
 * Drops a block whose normalized form equals the previous block's — the
 * doubled-card-title pattern ("Match previews" rendered twice in a row).
 */
function collapseDuplicateBlocks(blocks: readonly string[]): string[] {
  const kept: string[] = [];
  let previousKey: string | null = null;
  for (const block of blocks) {
    const key = block.toLowerCase().replace(/\s+/gu, ' ').trim();
    if (key !== previousKey) {
      kept.push(block);
    }
    previousKey = key;
  }
  return kept;
}
