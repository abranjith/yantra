/**
 * A templated report on the Run result page (FEAT-066 TASK-005): the
 * runtime-rendered Markdown through SafeMarkdown, then Sources, notices and
 * the metadata footer.
 */

import type { TemplatedReport } from '@yantra/protocol';
import { SafeMarkdown } from '@yantra/ui';
import type { ReactNode } from 'react';

import { MetadataFooter, NoticeList, SourceList } from './BriefDocument.js';
import { useEvidence } from './EvidenceProvider.js';

/** See the module comment. */
export function TemplatedDocument({ report }: { readonly report: TemplatedReport }): ReactNode {
  const evidence = useEvidence();
  const cited = report.sources.filter((source) => source.cited !== false);
  const consulted = report.sources.filter((source) => source.cited === false);
  return (
    <article
      aria-label={report.title}
      className="flex flex-col gap-6"
      data-document="templated_report"
    >
      <p className="type-label text-ink-2">
        From template <span className="type-engine">{report.template.name}</span>
      </p>
      <SafeMarkdown citations={evidence.citations}>{report.rendered_md}</SafeMarkdown>
      <SourceList sources={cited} heading="Sources" id="sources" />
      <SourceList sources={consulted} heading="Also consulted" id="also-consulted" />
      <NoticeList notices={report.notices} />
      <MetadataFooter metadata={report.metadata} />
    </article>
  );
}
