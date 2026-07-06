/**
 * `briefToMarkdown` — the portable `brief.md` artifact renderer.
 *
 * A **pure** `Brief → string` transform: no I/O, no clock, no randomness, and
 * no rendering dependencies (the Markdown is hand-assembled). It always emits
 * the *full* document regardless of any terminal `--detail` level — `brief.md`
 * is the shareable, diffable, GitHub-previewable record of a run.
 *
 * Determinism is a hard requirement: the same Brief always yields the same
 * bytes, which is what makes the renderer snapshot suite (FEAT-015 TASK-007)
 * possible. Ordering is taken straight from the Brief; nothing is sorted or
 * reshuffled here.
 *
 * The output never contains ANSI escape bytes — styling lives only in the
 * terminal renderer. Brief text fields are already ANSI-free by schema
 * refinement, and this function introduces no escapes of its own.
 */

import type { Brief, BriefSource, KeyFinding, Section } from '@yantra/protocol';

/**
 * Renders a {@link Brief} as a portable, full-detail Markdown document.
 *
 * The section order is stable: title, overview, key findings, detail
 * sections, comparison table, sources, then notices. Empty blocks are
 * omitted (no dangling headings) so the document reads cleanly whether the
 * Brief is a rich comparison or a bare overview.
 *
 * @param brief - A fully-formed, schema-valid Brief.
 * @returns The `brief.md` contents (no trailing newline).
 *
 * @example
 * const md = briefToMarkdown(brief);
 * await writeFile('brief.md', `${md}\n`, 'utf8');
 * // # Cheapest Sony WH-1000XM5 today
 * //
 * // > Lowest price is $328 at Amazon… [1][3]
 * // …
 */
export function briefToMarkdown(brief: Brief): string {
  const blocks: string[] = [];

  blocks.push(`# ${inline(brief.title)}`);

  const overview = brief.overview.trim();
  if (overview.length > 0) {
    blocks.push(blockquote(overview));
  }

  if (brief.key_findings.length > 0) {
    blocks.push(['## Key Findings', '', ...brief.key_findings.map(keyFindingLine)].join('\n'));
  }

  for (const section of brief.sections) {
    blocks.push(sectionBlock(section));
  }

  const comparison = brief.facets?.comparison ?? null;
  if (comparison !== null && comparison.rows.length > 0) {
    blocks.push(['## Comparison', '', comparisonTable(comparison)].join('\n'));
  }

  if (brief.sources.length > 0) {
    blocks.push(['## Sources', '', ...brief.sources.map(sourceLine)].join('\n'));
  }

  if (brief.notices.length > 0) {
    blocks.push(
      [
        '## Notices',
        '',
        ...brief.notices.map(
          (notice) =>
            `- **${inline(notice.kind)}** — ${inline(notice.source)}: ${inline(notice.reason)}`,
        ),
      ].join('\n'),
    );
  }

  return blocks.join('\n\n');
}

/** Renders one key finding bullet, tagging uncited editorial commentary. */
function keyFindingLine(finding: KeyFinding): string {
  const text = inline(finding.text);
  return finding.editorial ? `- ${text} *(editorial)*` : `- ${text}`;
}

/** Renders a detail section as an H2 heading followed by its Markdown body. */
function sectionBlock(section: Section): string {
  const body = section.body_md.trim();
  const heading = `## ${inline(section.heading)}`;
  return body.length > 0 ? `${heading}\n\n${body}` : heading;
}

/** Renders the comparison facet as a GitHub-flavored Markdown table. */
function comparisonTable(
  comparison: NonNullable<NonNullable<Brief['facets']>['comparison']>,
): string {
  const header = `| ${comparison.columns.map(cell).join(' | ')} |`;
  const divider = `| ${comparison.columns.map(() => '---').join(' | ')} |`;
  const rows = comparison.rows.map((row) => `| ${row.map(cell).join(' | ')} |`);
  return [header, divider, ...rows].join('\n');
}

/** Renders one numbered source as a Markdown link with provenance dates. */
function sourceLine(source: BriefSource): string {
  const label = inline(source.title ?? source.host);
  const meta = [`${inline(source.host)}`, `fetched ${source.fetched_at}`];
  if (source.published_at !== null) {
    meta.push(`published ${source.published_at}`);
  }
  return `${source.n}. [${label}](${source.url}) — ${meta.join(' · ')}`;
}

/** Formats a facet scalar for a table cell, escaping table-breaking chars. */
function cell(value: string | number | boolean | null): string {
  if (value === null) {
    return '';
  }
  if (typeof value === 'boolean') {
    return value ? '✓' : '✗';
  }
  return cellEscape(String(value));
}

/** Escapes pipes and newlines that would corrupt a Markdown table cell. */
function cellEscape(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** Collapses newlines in a single-line context (headings, list items). */
function inline(value: string): string {
  return value.replace(/\r?\n/g, ' ').trim();
}

/** Renders multi-paragraph text as a Markdown blockquote. */
function blockquote(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => (line.length > 0 ? `> ${line}` : '>'))
    .join('\n');
}
