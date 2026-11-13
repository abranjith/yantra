/**
 * A Brief on the Run result page (FEAT-066 TASK-005), in the order the CLI
 * and HTML renderers use: title, condition statuses, overview, key findings
 * (one level of children), sections, the comparison facet, requirements,
 * captures, Sources and Also consulted, notices by kind, and the metadata
 * footer. Every word the protocol defines is rendered verbatim; every
 * citation is a chip that opens its evidence.
 */

import type { Brief, BriefMetadata, BriefNotice, BriefSource, KeyFinding } from '@yantra/protocol';
import {
  CaptureGallery,
  ConditionTable,
  Link,
  RequirementList,
  SafeMarkdown,
  Table,
  type TableColumn,
} from '@yantra/ui';
import type { ReactNode } from 'react';

import { formatCost } from '../format.js';
import { ShowInFolder } from '../viewers/ShowInFolder.js';

import { ArtifactImage } from './artifact-links.js';
import { claimId, useEvidence } from './EvidenceProvider.js';

/**
 * Whether the editorial mark carries information: only when some finding is
 * not editorial. Mirrors protocol `editorialMarkIsInformative` (browser code
 * may import protocol types only); a test pins the two together.
 */
export function editorialMarkIsInformative(findings: readonly KeyFinding[]): boolean {
  return findings.some((finding) => !finding.editorial);
}

function SectionHeading({ id, children }: { readonly id: string; readonly children: ReactNode }) {
  return (
    <h2 id={id} className="text-lg font-semibold text-ink">
      {children}
    </h2>
  );
}

/** Sources (`cited !== false`) or Also consulted (`cited === false`). */
export function SourceList({
  sources,
  heading,
  id,
}: {
  readonly sources: readonly BriefSource[];
  readonly heading: string;
  readonly id: string;
}): ReactNode {
  if (sources.length === 0) return null;
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <SectionHeading id={id}>{heading}</SectionHeading>
      <ol className="flex flex-col gap-1">
        {sources.map((source) => (
          <li key={source.n} data-source={source.n} className="flex flex-wrap items-baseline gap-2">
            <span className="type-engine text-ink-2">[{source.n}]</span>
            <span className="text-ink-2">{source.host}</span>
            <Link href={source.final_url ?? source.url}>{source.title ?? source.url}</Link>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Notices grouped by kind, kind words verbatim. */
export function NoticeList({
  notices,
  id = 'notices',
}: {
  readonly notices: readonly BriefNotice[];
  readonly id?: string;
}): ReactNode {
  const byKind = new Map<string, BriefNotice[]>();
  for (const notice of notices)
    byKind.set(notice.kind, [...(byKind.get(notice.kind) ?? []), notice]);
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <SectionHeading id={id}>Notices</SectionHeading>
      {notices.length === 0 ? (
        <p className="text-ink-2">No notices recorded.</p>
      ) : (
        [...byKind].map(([kind, items]) => (
          <div key={kind} data-notice-kind={kind} className="flex flex-col gap-1">
            <h3 className="type-engine text-ink-2">{kind}</h3>
            <ul className="flex flex-col gap-1">
              {items.map((notice, index) => (
                <li key={`${notice.source}-${String(index)}`} className="text-ink">
                  <span className="text-ink-2">{notice.source}</span> — {notice.reason}
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </section>
  );
}

/** The provenance footer shared by Briefs and templated documents. */
export function MetadataFooter({ metadata }: { readonly metadata: BriefMetadata }): ReactNode {
  const verdict = metadata.citation_verdict;
  const rows: [string, string][] = [
    ['Synthesis', metadata.synthesis],
    ['Search provider', metadata.search_provider ?? 'none'],
    [
      'Coverage',
      metadata.coverage === null ? 'not measured' : `${Math.round(metadata.coverage * 100)}%`,
    ],
    [
      'Citation check',
      verdict === null
        ? 'not run'
        : `${String(verdict.claims_checked)} checked, ${String(verdict.flagged)} flagged, ${String(verdict.stripped)} stripped`,
    ],
    [
      'Usage',
      metadata.usage === null
        ? 'no model calls'
        : `${String(metadata.usage.input_tokens)} in, ${String(metadata.usage.output_tokens)} out tokens, ${formatCost(metadata.usage.cost_usd)}`,
    ],
  ];
  if (metadata.deterministic_fallback_used) rows.push(['Fallback', 'deterministic fallback used']);
  return (
    <footer aria-label="Document metadata" className="border-t border-rule pt-4">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
        {rows.map(([term, value]) => (
          <div key={term} className="contents">
            <dt className="type-label text-ink-2">{term}</dt>
            <dd className="text-ink">{value}</dd>
          </div>
        ))}
      </dl>
    </footer>
  );
}

interface ComparisonRow {
  readonly index: number;
  readonly cells: readonly (string | number | boolean | null)[];
}

function Comparison({ brief }: { readonly brief: Brief }): ReactNode {
  const evidence = useEvidence();
  const comparison = brief.facets?.comparison ?? null;
  if (comparison === null) return null;
  const columns: TableColumn<ComparisonRow>[] = [
    ...comparison.columns.map(
      (header, column): TableColumn<ComparisonRow> => ({
        id: `c${String(column)}`,
        header,
        ...(column === 0 ? { isRowHeader: true } : {}),
        cell: (row) => {
          const value = row.cells[column];
          return (
            <span {...(column === 0 ? { id: claimId.row(row.index) } : {})}>
              {value === null || value === undefined ? '—' : String(value)}
            </span>
          );
        },
      }),
    ),
    {
      id: 'evidence',
      header: 'Evidence',
      cell: (row) =>
        evidence.chips(comparison.row_citations?.[row.index], comparison.row_actions?.[row.index]),
    },
  ];
  const rows = comparison.rows.map((cells, index) => ({ index, cells }));
  return (
    <section aria-labelledby="comparison" className="flex flex-col gap-2">
      <SectionHeading id="comparison">Comparison</SectionHeading>
      <Table
        aria-labelledby="comparison"
        columns={columns}
        rows={rows}
        getRowKey={(row) => String(row.index)}
        emptyState="No comparison rows."
        height={`${String(Math.min(rows.length + 1, 12) * 40 + 2)}px`}
      />
    </section>
  );
}

/** See the module comment. */
export function BriefDocument({
  brief,
  runId,
}: {
  readonly brief: Brief;
  readonly runId: string;
}): ReactNode {
  const evidence = useEvidence();
  const showEditorial = editorialMarkIsInformative(brief.key_findings);
  const cited = brief.sources.filter((source) => source.cited !== false);
  const consulted = brief.sources.filter((source) => source.cited === false);

  return (
    <article aria-label={brief.title} className="flex flex-col gap-6" data-document="brief">
      {brief.constraints === undefined || brief.constraints.length === 0 ? null : (
        <ConditionTable
          constraints={brief.constraints}
          getRowId={claimId.condition}
          renderCitations={(citations) => evidence.chips(citations)}
        />
      )}

      <section aria-labelledby="overview" className="flex flex-col gap-2">
        <SectionHeading id="overview">Overview</SectionHeading>
        <SafeMarkdown citations={evidence.citations}>{brief.overview}</SafeMarkdown>
      </section>

      {brief.key_findings.length === 0 ? null : (
        <section aria-labelledby="findings" className="flex flex-col gap-2">
          <SectionHeading id="findings">Key findings</SectionHeading>
          <ul className="flex flex-col gap-3">
            {brief.key_findings.map((finding, index) => (
              <li
                key={claimId.finding(index)}
                id={claimId.finding(index)}
                data-finding={index + 1}
                className="flex flex-col gap-1"
              >
                <div className="flex flex-wrap items-baseline gap-2">
                  {showEditorial && finding.editorial ? (
                    <span
                      data-part="editorial"
                      className="type-label rounded-chip border border-rule px-1.5 text-ink-2"
                    >
                      editorial
                    </span>
                  ) : null}
                  <SafeMarkdown citations={evidence.citations} className="inline text-ink">
                    {finding.text}
                  </SafeMarkdown>
                  {evidence.chips(undefined, finding.actions)}
                </div>
                {finding.children.length === 0 ? null : (
                  <ul className="ms-6 flex list-disc flex-col gap-1">
                    {finding.children.map((child, childIndex) => (
                      <li
                        key={claimId.child(index, childIndex)}
                        id={claimId.child(index, childIndex)}
                      >
                        <SafeMarkdown citations={evidence.citations} className="inline text-ink">
                          {child.text}
                        </SafeMarkdown>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {brief.sections.map((section, index) => (
        <section
          key={claimId.section(index)}
          id={claimId.section(index)}
          aria-labelledby={`${claimId.section(index)}-heading`}
          className="flex flex-col gap-2"
        >
          <div className="flex flex-wrap items-center gap-2">
            <SectionHeading id={`${claimId.section(index)}-heading`}>
              {section.heading}
            </SectionHeading>
            {section.kind === 'alternatives' ? (
              <span
                data-part="alternatives"
                className="type-label rounded-chip border border-signal-partial px-1.5 text-signal-partial-ink"
              >
                alternatives
              </span>
            ) : null}
          </div>
          <SafeMarkdown citations={evidence.citations}>{section.body_md}</SafeMarkdown>
          {section.actions === undefined ? null : (
            <div>{evidence.chips(undefined, section.actions)}</div>
          )}
        </section>
      ))}

      <Comparison brief={brief} />

      {brief.requirements === undefined || brief.requirements.length === 0 ? null : (
        <section aria-labelledby="requirements" className="flex flex-col gap-2">
          <SectionHeading id="requirements">Requirements</SectionHeading>
          <RequirementList requirements={brief.requirements} />
        </section>
      )}

      {brief.artifacts === undefined || brief.artifacts.length === 0 ? null : (
        <section aria-labelledby="captures" className="flex flex-col gap-2">
          <SectionHeading id="captures">Captures</SectionHeading>
          <CaptureGallery
            items={brief.artifacts}
            {...(evidence.selectedCapture === null
              ? {}
              : { selectedPath: evidence.selectedCapture })}
            renderImage={(item) => (
              <ArtifactImage runId={runId} path={item.path} alt={`Capture ${item.path}`} />
            )}
            renderOversize={() => <ShowInFolder runId={runId} />}
          />
        </section>
      )}

      <SourceList sources={cited} heading="Sources" id="sources" />
      <SourceList sources={consulted} heading="Also consulted" id="also-consulted" />
      <NoticeList notices={brief.notices} />
      <MetadataFooter metadata={brief.metadata} />
    </article>
  );
}
