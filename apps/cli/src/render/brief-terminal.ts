/**
 * Rich terminal renderer for the Brief (FEAT-015, TASK-004).
 *
 * This is the deliberate reversal of the MVP renderer's "no TTY-decoration
 * dependency" stance (see the header of `render/terminal.ts`): plan §8 makes
 * presentation a first-class product concern, so the Brief surface adopts a
 * small, well-maintained rendering toolchain — `boxen` (overview panel),
 * `chalk` (color + glyphs), `cli-table3` (comparison tables), and
 * `marked-terminal` (word-wrapped section bodies). The parallel `--json` path
 * stays dependency-free and is guarded by `scripts/ci-static-check.ts`.
 *
 * The renderer holds **zero business logic** (plan §7): it accepts a fully
 * formed, schema-valid Brief and styles it. All synthesis decisions (what to
 * include, citation mapping) happen upstream.
 *
 * Progressive disclosure (§2 detail contract):
 * - `overview`  → title + overview panel + sources
 * - `standard`  → + key findings + comparison table + notices
 * - `full`      → + detail sections + per-source url/date lines
 *
 * Color is forced on/off explicitly (not TTY-sniffed) so output is
 * deterministic and snapshot-stable. Under `noColor`, every styling call
 * degrades to identity and the box loses its colored border — the output
 * contains no ANSI escape bytes at all.
 */

import type { Brief, BriefNotice, BriefSource, KeyFinding, Section } from '@yantra/protocol';
import boxen, { type Options as BoxenOptions } from 'boxen';
import { Chalk, type ChalkInstance } from 'chalk';
import Table from 'cli-table3';
import { Marked, type MarkedExtension } from 'marked';
import { markedTerminal } from 'marked-terminal';

import type { BriefDetailLevel } from './types.js';

export type { BriefDetailLevel } from './types.js';

/** Options controlling one terminal render. */
export interface BriefTerminalOptions {
  /** Disclosure level; defaults to `standard`. */
  readonly detail?: BriefDetailLevel;
  /** Suppress all color/box borders (from `--no-color`/`NO_COLOR`/non-TTY). */
  readonly noColor?: boolean;
  /** Target column width; clamped to [60, 120]. Defaults to 80. */
  readonly width?: number;
}

const MIN_WIDTH = 60;
const MAX_WIDTH = 120;
const DEFAULT_WIDTH = 80;

/**
 * Renders a {@link Brief} to a styled (or plain) terminal string.
 *
 * @param brief - A fully-formed, schema-valid Brief.
 * @param options - Detail level, color suppression, and target width.
 * @returns The rendered block, ready to write to stdout (no trailing newline).
 *
 * @example
 * process.stdout.write(`${renderBriefTerminal(brief, { detail: 'full' })}\n`);
 */
export function renderBriefTerminal(brief: Brief, options: BriefTerminalOptions = {}): string {
  const detail = options.detail ?? 'standard';
  const color = options.noColor !== true;
  const width = clampWidth(options.width);
  const c = new Chalk({ level: color ? 1 : 0 });

  const blocks: string[] = [overviewPanel(brief, c, color, width)];

  if (detail !== 'overview') {
    if (brief.key_findings.length > 0) {
      blocks.push(keyFindingsBlock(brief.key_findings, c));
    }
    const comparison = brief.facets?.comparison ?? null;
    if (comparison !== null && comparison.rows.length > 0) {
      blocks.push(comparisonBlock(comparison, c, color, width));
    }
  }

  if (detail === 'full' && brief.sections.length > 0) {
    blocks.push(sectionsBlock(brief.sections, c, width));
  }

  if (detail !== 'overview' && brief.notices.length > 0) {
    blocks.push(noticesBlock(brief.notices, c));
  }

  if (brief.sources.length > 0) {
    blocks.push(sourcesBlock(brief.sources, c, detail));
  }

  return blocks.join('\n\n');
}

/** Clamps a requested width into the supported [60, 120] range. */
function clampWidth(width: number | undefined): number {
  if (width === undefined || !Number.isFinite(width)) {
    return DEFAULT_WIDTH;
  }
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.trunc(width)));
}

/** Title line + boxed overview panel (borderless + uncolored under noColor). */
function overviewPanel(brief: Brief, c: ChalkInstance, color: boolean, width: number): string {
  const title = c.bold(brief.title);
  const overview = styleInline(brief.overview.trim(), c);
  const content = overview.length > 0 ? overview : c.dim('(no overview available)');

  const boxOptions: BoxenOptions = {
    padding: { top: 0, bottom: 0, left: 1, right: 1 },
    borderStyle: color ? 'round' : 'none',
    width,
    ...(color ? { borderColor: 'cyan' } : {}),
  };

  return `${title}\n${boxen(content, boxOptions)}`;
}

/** Scannable key-finding bullets; editorial notes use a distinct glyph. */
function keyFindingsBlock(findings: readonly KeyFinding[], c: ChalkInstance): string {
  const lines = findings.flatMap((finding) => {
    const glyph = finding.editorial ? c.yellow('◦') : c.green('•');
    const marker = finding.editorial ? c.dim(' (editorial)') : '';
    const body = findingText(finding.text, finding.citations, c);
    return [
      `${glyph} ${body}${marker}`,
      ...(finding.children ?? []).map(
        (child) => `  ${c.dim('◦')} ${c.dim(findingText(child.text, child.citations, c))}`,
      ),
    ];
  });
  return `${c.bold('Key Findings')}\n${lines.join('\n')}`;
}

function findingText(text: string, citations: readonly number[], c: ChalkInstance): string {
  const styled = styleInline(text, c);
  if (/\[\d+\]/u.test(text) || citations.length === 0) {
    return styled;
  }
  return `${styled} ${citations.map((n) => c.cyan(`[${n}]`)).join('')}`;
}

/** Comparison facet as an aligned `cli-table3`, width-fitted so it never overflows. */
function comparisonBlock(
  comparison: NonNullable<NonNullable<Brief['facets']>['comparison']>,
  c: ChalkInstance,
  color: boolean,
  width: number,
): string {
  const table = new Table({
    head: [...comparison.columns],
    colWidths: distributeWidth(width, comparison.columns.length),
    wordWrap: true,
    // Colors are applied via the label + surrounding blocks, not here, so the
    // table stays free of `@colors/colors` TTY-detection nondeterminism.
    style: { head: color ? ['cyan'] : [], border: [] },
  });
  for (const row of comparison.rows) {
    table.push(row.map(cellText));
  }
  return `${c.bold('Comparison')}\n${table.toString()}`;
}

/** Splits a target width into per-column widths that sum (with borders) to width. */
function distributeWidth(width: number, columns: number): number[] {
  const inner = width - (columns + 1);
  const base = Math.floor(inner / columns);
  const extra = inner - base * columns;
  return Array.from({ length: columns }, (_, index) => Math.max(3, base + (index < extra ? 1 : 0)));
}

/** Detail sections: heading + word-wrapped Markdown body via marked-terminal. */
function sectionsBlock(sections: readonly Section[], c: ChalkInstance, width: number): string {
  const md = markdownRenderer(c, width);
  return sections
    .map((section) => {
      const body = renderSectionBody(section.body_md, md);
      return `${c.bold(section.heading)}\n${body}`;
    })
    .join('\n\n');
}

/** Renders GFM tables as aligned plain columns and other chunks as Markdown. */
function renderSectionBody(bodyMd: string, md: Marked): string {
  const lines = bodyMd.split(/\r?\n/u);
  const output: string[] = [];
  for (let index = 0; index < lines.length; ) {
    if (lines[index]!.trim().startsWith('|')) {
      const table: string[] = [];
      while (index < lines.length && lines[index]!.trim().startsWith('|')) {
        table.push(lines[index]!.trim());
        index += 1;
      }
      output.push(alignMarkdownTable(table));
      continue;
    }
    const markdown: string[] = [];
    while (index < lines.length && !lines[index]!.trim().startsWith('|')) {
      markdown.push(lines[index]!);
      index += 1;
    }
    const rendered = (md.parse(markdown.join('\n')) as string).replace(/\n+$/u, '');
    if (rendered.length > 0) output.push(rendered);
  }
  return output.join('\n');
}

function alignMarkdownTable(lines: readonly string[]): string {
  const rows = lines
    .map((line) =>
      line
        .slice(1, line.endsWith('|') ? -1 : undefined)
        .split('|')
        .map((cell) => cell.trim()),
    )
    .filter((_, index) => index !== 1);
  const widths = Array.from(
    { length: Math.max(0, ...rows.map((row) => row.length)) },
    (_, column) => Math.max(...rows.map((row) => row[column]?.length ?? 0)),
  );
  return rows
    .map((row) =>
      row
        .map((cell, column) => cell.padEnd(widths[column] ?? cell.length))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

/** Honest per-source failures as a yellow block. */
function noticesBlock(notices: readonly BriefNotice[], c: ChalkInstance): string {
  const lines = notices.map((notice) => c.yellow(`⚠ ${notice.source}: ${notice.reason}`));
  return `${c.bold('Notices')}\n${lines.join('\n')}`;
}

/** Dim numbered source list; `full` detail adds a per-source url/date line. */
function sourcesBlock(
  sources: readonly BriefSource[],
  c: ChalkInstance,
  detail: BriefDetailLevel,
): string {
  const lines = sources.flatMap((source) => {
    const label = source.title ?? source.host;
    const head = `${c.cyan(`[${source.n}]`)} ${label} ${c.dim(`— ${source.host}`)}`;
    if (detail !== 'full') {
      return [head];
    }
    const meta = [`fetched ${source.fetched_at}`];
    if (source.published_at !== null) {
      meta.push(`published ${source.published_at}`);
    }
    return [head, c.dim(`    ${source.url}  ${meta.join(' · ')}`)];
  });
  return `${c.bold('Sources')}\n${lines.join('\n')}`;
}

/**
 * Renders inline Markdown emphasis and colors `[n]` citation markers. Handles
 * `**bold**`/`__bold__` and `` `code` ``; the emphasis markers are consumed
 * even under noColor (where the styling is identity), so raw `**` never leaks
 * into the terminal.
 */
function styleInline(text: string, c: ChalkInstance): string {
  return text
    .replace(/\*\*([^*]+)\*\*/gu, (_match, inner: string) => c.bold(inner))
    .replace(/__([^_]+)__/gu, (_match, inner: string) => c.bold(inner))
    .replace(/`([^`]+)`/gu, (_match, inner: string) => c.cyan(inner))
    .replace(/\[(\d+)\]/gu, (marker) => c.cyan(marker));
}

/** Renders a facet scalar for a table cell. */
function cellText(value: string | number | boolean | null): string {
  if (value === null) {
    return '';
  }
  if (typeof value === 'boolean') {
    return value ? '✓' : '✗';
  }
  return String(value);
}

/**
 * Builds a marked-terminal Markdown renderer whose styles are bound to the
 * leveled chalk instance — so section bodies word-wrap to `width` and emit ANSI
 * only in color mode (identity styling under noColor).
 */
function markdownRenderer(c: ChalkInstance, width: number): Marked {
  const marked = new Marked();
  const options = {
    width,
    reflowText: true,
    tab: 2,
    strong: (s: string) => c.bold(s),
    em: (s: string) => c.italic(s),
    codespan: (s: string) => c.cyan(s),
    del: (s: string) => c.strikethrough(s),
    link: (s: string) => c.cyan(s),
    href: (s: string) => c.blue(s),
    blockquote: (s: string) => c.dim(s),
    code: (s: string) => c.dim(s),
    heading: (s: string) => c.bold(s),
    firstHeading: (s: string) => c.bold(s),
    hr: (s: string) => c.dim(s),
  };

  // @types/marked-terminal is written for the pre-v7 API where
  // `markedTerminal()` returns a `TerminalRenderer`; marked@15's `use()` wants
  // a `MarkedExtension`. The v7 runtime returns exactly that (the probe renders
  // correctly), so only the return type is bridged across the version skew.
  marked.use(markedTerminal(options) as unknown as MarkedExtension);
  return marked;
}
