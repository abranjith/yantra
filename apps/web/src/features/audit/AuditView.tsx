/**
 * The app's Audit (FEAT-066 TASK-009): the same story `yantra audit` tells,
 * from the same builder (`read.audit`), paged so that a run of any size stays
 * within message limits.
 *
 * The trust narrative (with any schedule linkage), provider provenance with
 * the session log as an artifact link when the run publishes it, usage,
 * secret lookups (keys only; the value is always a ProtectedValue), the
 * scope mix, a virtualized, cursor-paged table of tool calls with status and
 * confirmation words verbatim, the captures with where each went, and a
 * startup failure.
 */

import type { ArtifactInventoryItem, AuditReport } from '@yantra/protocol';
import {
  Button,
  CaptureGallery,
  ProtectedValue,
  Table,
  type TableColumn,
  type TableLoadState,
} from '@yantra/ui';
import type { ReactNode } from 'react';

import { useAuditPages } from '../../data/runs.js';
import { formatCost, formatDuration, NOT_RECORDED } from '../format.js';
import { ArtifactImage, ViewerLink } from '../run-result/artifact-links.js';
import { ShowInFolder } from '../viewers/ShowInFolder.js';

type ToolCallRow = AuditReport['toolCalls'][number];

const TOOL_COLUMNS: readonly TableColumn<ToolCallRow>[] = [
  {
    id: 'seq',
    header: '#',
    width: 72,
    align: 'end',
    voice: 'engine',
    cell: (call) => String(call.seq),
  },
  { id: 'tool', header: 'Tool', isRowHeader: true, voice: 'engine', cell: (call) => call.tool },
  { id: 'status', header: 'Status', width: 120, voice: 'engine', cell: (call) => call.status },
  {
    id: 'duration',
    header: 'Duration',
    width: 110,
    align: 'end',
    cell: (call) => formatDuration(call.durationMs),
  },
  {
    id: 'decision',
    header: 'Confirmation',
    width: 140,
    voice: 'engine',
    cell: (call) =>
      call.confirmationDecision ?? (call.confirmationId === null ? NOT_RECORDED : 'pending'),
  },
  {
    id: 'incomplete',
    header: 'Finished',
    width: 110,
    cell: (call) => (call.incomplete ? 'incomplete' : 'yes'),
  },
];

function Region({
  id,
  heading,
  children,
}: {
  readonly id: string;
  readonly heading: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <section aria-labelledby={id} data-audit-region={id} className="flex flex-col gap-2">
      <h2 id={id} className="text-lg font-semibold text-ink">
        {heading}
      </h2>
      {children}
    </section>
  );
}

function Pairs({ rows }: { readonly rows: readonly (readonly [string, ReactNode])[] }): ReactNode {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
      {rows.map(([term, value]) => (
        <div key={term} className="contents">
          <dt className="type-label text-ink-2">{term}</dt>
          <dd className="text-ink">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Provenance({
  report,
  runId,
  artifacts,
}: {
  readonly report: AuditReport;
  readonly runId: string;
  readonly artifacts: readonly ArtifactInventoryItem[];
}): ReactNode {
  const agent = report.agent;
  if (agent === null) {
    return (
      <Region id="audit-provenance" heading="Provenance">
        <p className="text-ink-2">This run made no agent session.</p>
      </Region>
    );
  }
  const sessionListed = artifacts.some((item) => item.path === agent.sessionFile);
  return (
    <Region id="audit-provenance" heading="Provenance">
      <Pairs
        rows={[
          ['Adapter', <span className="type-engine">{agent.adapter}</span>],
          ['SDK version', <span className="type-engine">{agent.sdkVersion}</span>],
          ['Provider', agent.provider],
          ['Model', <span className="type-engine">{agent.model}</span>],
          ['Thinking', agent.thinking],
          ['Auth source', agent.authSource],
          ['Prompt version', <span className="type-engine">{agent.promptVersion}</span>],
          [
            'Session log',
            sessionListed ? (
              <ViewerLink runId={runId} path={agent.sessionFile}>
                {agent.sessionFile}
              </ViewerLink>
            ) : (
              <span className="type-engine">{agent.sessionFile}</span>
            ),
          ],
        ]}
      />
    </Region>
  );
}

function ToolCalls({ runId }: { readonly runId: string }): ReactNode {
  const pages = useAuditPages(runId, 'tool_calls');
  const rows = pages.data?.pages.flatMap((page) => page.report.toolCalls) ?? [];
  const total = pages.data?.pages[0]?.tool_calls.total ?? 0;
  const loadState: TableLoadState = pages.isFetchingNextPage
    ? 'loading'
    : pages.isFetchNextPageError
      ? 'error'
      : pages.hasNextPage
        ? 'idle'
        : 'exhausted';
  return (
    <Region id="audit-tool-calls" heading={`Tool calls (${String(total)})`}>
      <Table
        aria-labelledby="audit-tool-calls"
        columns={TOOL_COLUMNS}
        rows={rows}
        getRowKey={(call) => call.callId}
        height="24rem"
        loadState={loadState}
        onLoadMore={() => {
          if (pages.hasNextPage) void pages.fetchNextPage({ cancelRefetch: false });
        }}
        emptyState="This run made no tool calls."
      />
    </Region>
  );
}

function Captures({
  report,
  runId,
}: {
  readonly report: AuditReport;
  readonly runId: string;
}): ReactNode {
  const pages = useAuditPages(runId, 'captures');
  const captures = pages.data?.pages.flatMap((page) => page.report.captures) ?? report.captures;
  const total = pages.data?.pages[0]?.captures.total ?? report.captures.length;
  return (
    <Region id="audit-captures" heading={`Captures (${String(total)})`}>
      {report.rawSessionLogCaptureBearing && report.agent !== null ? (
        <p role="note" data-part="raw-session-warning" className="text-signal-partial-ink">
          Raw provider session log {report.agent.sessionFile} contains the image data itself.
        </p>
      ) : null}
      <CaptureGallery
        items={captures.map((capture) => ({
          path: capture.path,
          bytes: capture.bytes,
          width: capture.width,
          height: capture.height,
          sentToModel: capture.sentToModel,
        }))}
        renderImage={(item) => (
          <ArtifactImage runId={runId} path={item.path} alt={`Capture ${item.path}`} />
        )}
        renderOversize={() => <ShowInFolder runId={runId} />}
      />
      {pages.hasNextPage ? (
        <Button
          size="sm"
          variant="secondary"
          isPending={pages.isFetchingNextPage}
          onPress={() => void pages.fetchNextPage()}
        >
          Load more captures
        </Button>
      ) : null}
    </Region>
  );
}

/** See the module comment. */
export function AuditView({
  runId,
  artifacts,
}: {
  readonly runId: string;
  readonly artifacts: readonly ArtifactInventoryItem[];
}): ReactNode {
  const first = useAuditPages(runId, 'tool_calls');
  if (first.isError) return <p className="text-signal-failed-ink">{first.error.message}</p>;
  const report = first.data?.pages[0]?.report;
  if (report === undefined) {
    return (
      <p role="status" className="text-ink-2">
        Loading the audit…
      </p>
    );
  }
  const scope = report.scopeMix;
  return (
    <div data-part="audit" className="flex flex-col gap-6">
      <p data-part="trust-narrative" className="text-ink">
        {report.trustNarrative}
      </p>
      {report.terminalError === null ? null : (
        <Region id="audit-terminal-error" heading="Startup failure">
          <Pairs
            rows={[
              ['Code', <span className="type-engine">{report.terminalError.code}</span>],
              ['Message', report.terminalError.message],
            ]}
          />
        </Region>
      )}
      <Provenance report={report} runId={runId} artifacts={artifacts} />
      <Region id="audit-usage" heading="Usage">
        {report.usage === null ? (
          <p className="text-ink-2">
            No provider usage recorded ({String(report.llmCallCount)} model calls).
          </p>
        ) : (
          <Pairs
            rows={[
              ['Turns', String(report.usage.turns)],
              [
                'Input tokens',
                report.usage.inputTokens === null ? NOT_RECORDED : String(report.usage.inputTokens),
              ],
              [
                'Output tokens',
                report.usage.outputTokens === null
                  ? NOT_RECORDED
                  : String(report.usage.outputTokens),
              ],
              ['Cost', formatCost(report.usage.costUsd)],
            ]}
          />
        )}
      </Region>
      <Region
        id="audit-secrets"
        heading={`Secret lookups (${String(report.secretLookups.length)})`}
      >
        {report.secretLookups.length === 0 ? (
          <p className="text-ink-2">No secrets were resolved.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {report.secretLookups.map((lookup, index) => (
              <li
                key={`${lookup.key}-${String(index)}`}
                data-secret-key={lookup.key}
                className="flex flex-wrap items-center gap-3"
              >
                <span className="type-engine text-ink">{lookup.key}</span>
                {lookup.stepId.length === 0 ? null : (
                  <span className="text-ink-2">
                    step <span className="type-engine">{lookup.stepId}</span>
                  </span>
                )}
                <ProtectedValue reason="stored_secret" />
              </li>
            ))}
          </ul>
        )}
      </Region>
      <Region id="audit-scope" heading="Scope mix">
        <Pairs
          rows={[
            ['Steps', String(report.stepCount)],
            ['public', String(scope.publicCount)],
            ['read-only-data', String(scope.readOnlyDataCount)],
            ['authenticated', String(scope.authenticatedCount)],
          ]}
        />
      </Region>
      <ToolCalls runId={runId} />
      <Captures report={report} runId={runId} />
    </div>
  );
}
