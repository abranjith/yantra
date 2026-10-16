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

import {
  editorialMarkIsInformative,
  type Brief,
  type BriefRequirement,
  type BriefSource,
  type KeyFinding,
  type Section,
} from '@yantra/protocol';

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
  if (brief.constraints !== undefined && brief.constraints.length > 0) {
    blocks.push(
      `**Conditions:** ${brief.constraints.map((condition) => `${inline(condition.name)} = ${inline(condition.value)} ${condition.status === 'verified' ? '✓ verified' : condition.status === 'violated' ? '✗ not met' : '— unverified'}${condition.citations.length > 0 ? ` ${capMarkers(condition.citations)}` : ''}`).join(' · ')}`,
    );
  }

  if (brief.requirements !== undefined && brief.requirements.length > 0) {
    blocks.push(['## Requirements', '', ...brief.requirements.map(requirementLines)].join('\n'));
  }

  const overview = brief.overview.trim();
  if (overview.length > 0) {
    blocks.push(blockquote(capInlineMarkers(overview)));
  }

  if (brief.key_findings.length > 0) {
    const markEditorial = editorialMarkIsInformative(brief.key_findings);
    blocks.push(
      [
        '## Key Findings',
        '',
        ...brief.key_findings.map((finding) => keyFindingLine(finding, markEditorial)),
      ].join('\n'),
    );
  }

  for (const section of brief.sections) {
    blocks.push(sectionBlock(section));
  }

  const comparison = brief.facets?.comparison ?? null;
  if (comparison !== null && comparison.rows.length > 0) {
    blocks.push(['## Comparison', '', comparisonTable(comparison)].join('\n'));
  }

  if (brief.sources.length > 0) {
    const cited = brief.sources.filter((source) => source.cited !== false);
    const consulted = brief.sources.filter((source) => source.cited === false);
    if (cited.length > 0) blocks.push(['## Sources', '', ...cited.map(sourceLine)].join('\n'));
    if (consulted.length > 0)
      blocks.push(['## Also consulted', '', ...consulted.map(sourceLine)].join('\n'));
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

  return blocks.join('\n\n').replace(/\n{3,}/gu, '\n\n');
}

/** Max citation markers shown before collapsing the rest into a `(+k)` count. */
const MAX_VISIBLE_CITATIONS = 3;

/**
 * Caps a citation-number list to `[1][4][7] (+2)` form — the same visual
 * budget as the HTML superscripts, keeping `brief.md` scannable. Full evidence
 * for every finding remains in `brief.json`.
 */
function capMarkers(numbers: readonly number[]): string {
  if (numbers.length === 0) {
    return '';
  }
  const visible = numbers.slice(0, MAX_VISIBLE_CITATIONS);
  const base = visible.map((n) => `[${n}]`).join('');
  const overflow = numbers.length - visible.length;
  return overflow > 0 ? `${base} (+${overflow})` : base;
}

/** Caps inline `[n]`/`[n][m]` marker runs in free prose to the same budget. */
function capInlineMarkers(text: string): string {
  return text.replace(/(?:\[\d+\])+/gu, (run) =>
    capMarkers([...run.matchAll(/\[(\d+)\]/gu)].map((m) => Number(m[1]))),
  );
}

/**
 * Renders one key finding bullet, tagging uncited editorial commentary.
 *
 * @param markEditorial - Whether the editorial tag distinguishes anything in
 *   this Brief (see `editorialMarkIsInformative`); false suppresses it.
 */
function keyFindingLine(finding: KeyFinding, markEditorial: boolean): string {
  const text = inline(finding.text);
  // Structured citations are authoritative on the deterministic path; an LLM
  // finding may inline its own [n], which we cap in place instead.
  const body = /\[\d+\]/u.test(text)
    ? capInlineMarkers(text)
    : appendMarkers(text, finding.citations);
  const parent = markEditorial && finding.editorial ? `- ${body} *(editorial)*` : `- ${body}`;
  const children = (finding.children ?? []).map(
    (child) => `  - ${inline(child.text)} ${capMarkers(child.citations)}`,
  );
  return [parent, ...children].join('\n');
}

/** Appends capped citation markers to a finding's text, space-separated. */
function appendMarkers(text: string, numbers: readonly number[]): string {
  const markers = capMarkers(numbers);
  return markers.length > 0 ? `${text} ${markers}` : text;
}

/** Renders a detail section as an H2 heading followed by its Markdown body. */
function sectionBlock(section: Section): string {
  const body = cleanSectionBody(section.body_md);
  const heading = `## ${inline(section.heading)}`;
  return body.length > 0 ? `${heading}\n\n${body}` : heading;
}

function cleanSectionBody(bodyMd: string): string {
  return bodyMd
    .split(/\r?\n/u)
    .map((line) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        return '';
      }
      // GFM key-figures tables are already composed and escaped upstream.
      if (trimmed.startsWith('|')) {
        return capInlineMarkers(line.trimEnd());
      }
      const marker = /^\s{2}-\s/u.test(line) ? '  - ' : /^-\s/u.test(trimmed) ? '- ' : '';
      const content =
        marker.length > 0 ? trimmed.replace(/^-\s/u, '').replace(/^\s{2}-\s/u, '') : trimmed;
      return `${marker}${capInlineMarkers(inline(content))}`;
    })
    .filter((line) => line.length > 0)
    .join('\n');
}

/** Renders the comparison facet as a GitHub-flavored Markdown table. */
function comparisonTable(
  comparison: NonNullable<NonNullable<Brief['facets']>['comparison']>,
): string {
  const columns = [
    ...comparison.columns,
    ...(comparison.row_citations === undefined ? [] : ['Sources']),
  ];
  const header = `| ${columns.map(cell).join(' | ')} |`;
  const divider = `| ${columns.map(() => '---').join(' | ')} |`;
  const rows = comparison.rows.map(
    (row, i) =>
      `| ${[...row.map(cell), ...(comparison.row_citations === undefined ? [] : [capMarkers(comparison.row_citations[i] ?? [])])].join(' | ')} |`,
  );
  return [header, divider, ...rows].join('\n');
}

/** Renders one numbered source as a Markdown link with provenance dates. */
function sourceLine(source: BriefSource): string {
  const label = inline(source.title ?? source.host);
  const meta = [`${inline(source.host)}`, `fetched ${source.fetched_at}`];
  if (source.published_at !== null) {
    meta.push(`published ${source.published_at}`);
  }
  const line = `${source.n}. [${label}](${source.url}) — ${meta.join(' · ')}`;
  // typeof-guard rather than a null check: pre-excerpt Briefs read from disk
  // without a schema re-parse carry no excerpt property at all.
  if (typeof source.excerpt === 'string' && source.excerpt.trim().length > 0) {
    // Three-space continuation keeps the blockquote inside the ordered-list item.
    return `${line}\n   > ${inline(source.excerpt)}`;
  }
  return line;
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

/** The status glyph and word for one requirement. */
const REQUIREMENT_STATUS: Readonly<Record<BriefRequirement['status'], string>> = {
  met: '✓ met',
  unmet: '✗ unmet',
  not_applicable: '– not applicable',
};

/** Readable words for each fill exemption reason. */
export const FILL_EXEMPTION_WORDS: Readonly<
  Record<NonNullable<BriefRequirement['exemptions']>[number]['reason'], string>
> = {
  disabled: 'disabled',
  read_only: 'read-only',
  hidden: 'hidden',
  file_input: 'file upload',
  human_verification: 'human verification',
};

/** One requirement as a list item, its exemptions as a nested line. */
function requirementLines(requirement: BriefRequirement): string {
  const declared =
    requirement.declared_in !== null && requirement.declared_in > 1
      ? ` (declared in revision ${requirement.declared_in})`
      : '';
  const reason = requirement.reason === null ? '' : ` — ${inline(requirement.reason)}`;
  const lines = [
    `- ${REQUIREMENT_STATUS[requirement.status]}: ${inline(requirement.label)}${reason}${declared}`,
  ];
  const exemptions = requirement.exemptions ?? [];
  if (exemptions.length > 0) {
    const listed = exemptions
      .map((entry) => `${inline(entry.label)} (${FILL_EXEMPTION_WORDS[entry.reason]})`)
      .join(', ');
    const more =
      requirement.exempt_overflow === undefined ? '' : ` (+${requirement.exempt_overflow} more)`;
    lines.push(`  - Exempt: ${listed}${more}`);
  }
  return lines.join('\n');
}
