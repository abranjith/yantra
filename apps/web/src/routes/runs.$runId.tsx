/**
 * Run result (`/runs/<id>`, FEAT-066 TASK-005): the `open` command's in-app
 * adapter.
 *
 * - The header carries the outcome in the CLI's words, mode, times, duration
 *   and the CLI twin (`yantra open <id>`).
 * - Tabs: **Result** (the Brief or templated document, or the no-document
 *   result), **Audit**, and **Files** (the public inventory).
 * - Each artifact renders its own state: a missing, corrupt, older-format or
 *   oversized document shows why and how to recover, and the rest of the
 *   page still renders. Only an unknown run is a route-level error.
 * - A live run shows its state and refreshes on change hints.
 */

import { createRoute, Link as RouterLink } from '@tanstack/react-router';
import type { ArtifactInventoryItem, LedgerDisplayedState, RunResultView } from '@yantra/protocol';
import { Button, OutcomeBadge, Tab, TabList, TabPanel, Tabs } from '@yantra/ui';
import { useMemo, useState, type ReactNode } from 'react';

import { rootRoute } from '../app/root-route.js';
import { useRunResult, useRunsChangeInvalidation } from '../data/runs.js';
import { formatBytes, formatDuration, formatTimestamp, NOT_RECORDED } from '../features/format.js';
import { DownloadArtifact, ViewerLink } from '../features/run-result/artifact-links.js';
import { BriefDocument } from '../features/run-result/BriefDocument.js';
import { CliTwin } from '../features/run-result/CliTwin.js';
import {
  EvidenceProvider,
  indexBrief,
  indexSources,
} from '../features/run-result/EvidenceProvider.js';
import { SlotState } from '../features/run-result/SlotState.js';
import { TemplatedDocument } from '../features/run-result/TemplatedDocument.js';
import { RpcCallError } from '../host/rpc-client.js';

/** The tabs of the Run result page. */
export type RunTab = 'result' | 'audit' | 'files';

const LIVE_STATE: Readonly<
  Record<NonNullable<RunResultView['live']>['state'], LedgerDisplayedState>
> = {
  running: 'running',
  waiting_for_you: 'waiting_for_you',
  unknown_owner: 'unknown_owner',
};

function RunHeader({ view }: { readonly view: RunResultView }): ReactNode {
  return (
    <header className="flex flex-col gap-3">
      <h1 className="text-xl font-semibold text-ink">{view.title}</h1>
      <div className="flex flex-wrap items-center gap-4">
        <OutcomeBadge
          status={view.status}
          taskOutcome={view.task_outcome ?? undefined}
          executionState={view.execution_state ?? undefined}
          displayedState={view.live === null ? undefined : LIVE_STATE[view.live.state]}
        />
        <dl className="flex flex-wrap gap-x-4 gap-y-1">
          {(
            [
              ['Mode', view.mode],
              ['Started', formatTimestamp(view.started_at)],
              ['Ended', formatTimestamp(view.ended_at)],
              ['Duration', formatDuration(view.duration_ms)],
            ] as const
          ).map(([term, value]) => (
            <div key={term} className="flex gap-1">
              <dt className="type-label text-ink-2">{term}</dt>
              <dd className="text-ink">{value}</dd>
            </div>
          ))}
        </dl>
      </div>
      {view.live?.state === 'unknown_owner' ? (
        <p role="note" className="text-signal-partial-ink">
          Status unknown — the owner of this run can’t be verified.
        </p>
      ) : null}
      <p className="type-engine text-ink-2">{view.run_id}</p>
      <CliTwin command={`yantra open ${view.run_id}`} />
    </header>
  );
}

/** The document region of the Result tab. */
export function DocumentRegion({ view }: { readonly view: RunResultView }): ReactNode {
  const document = view.document;
  const index = useMemo(() => {
    if (document.kind === 'brief' && document.slot.state === 'ok')
      return indexBrief(document.slot.value);
    if (document.kind === 'templated_report' && document.slot.state === 'ok') {
      return indexSources(document.slot.value.sources);
    }
    return indexSources([]);
  }, [document]);

  if (document.kind === 'none') {
    return <p className="text-ink-2">This run saved no Brief or document.</p>;
  }
  if (document.slot.state !== 'ok') {
    return (
      <SlotState
        slot={document.slot}
        label={document.kind === 'brief' ? 'Brief' : 'document'}
        runId={view.run_id}
        artifacts={view.artifacts}
      />
    );
  }
  return (
    <EvidenceProvider index={index}>
      {document.kind === 'brief' ? (
        <BriefDocument brief={document.slot.value} runId={view.run_id} />
      ) : (
        <TemplatedDocument report={document.slot.value} />
      )}
    </EvidenceProvider>
  );
}

function FileAction({
  item,
  runId,
}: {
  readonly item: ArtifactInventoryItem;
  readonly runId: string;
}) {
  if (item.exposure === 'typed') return <span className="text-ink-2">Shown on the Result tab</span>;
  if (item.exposure === 'download') {
    return (
      <DownloadArtifact runId={runId} path={item.path}>
        Download
      </DownloadArtifact>
    );
  }
  return (
    <ViewerLink runId={runId} path={item.path}>
      View
    </ViewerLink>
  );
}

/** The Files tab: every public file of the run. */
export function FilesRegion({ view }: { readonly view: RunResultView }): ReactNode {
  if (view.artifacts.length === 0)
    return <p className="text-ink-2">No files recorded for this run.</p>;
  return (
    <div className="flex flex-col gap-2">
      <ul aria-label="Run files" className="flex flex-col gap-1">
        {view.artifacts.map((item) => (
          <li key={item.path} data-file={item.path} className="flex flex-wrap items-center gap-3">
            <span className="type-engine text-ink">{item.path}</span>
            <span className="text-ink-2">{formatBytes(item.bytes)}</span>
            <FileAction item={item} runId={view.run_id} />
          </li>
        ))}
      </ul>
      {view.artifacts_truncated ? (
        <p role="note" className="text-ink-2">
          Only the first {view.artifacts.length} files are listed.
        </p>
      ) : null}
    </div>
  );
}

/** The Run result page for one run, opened on `tab`. */
export function RunPage({
  runId,
  tab = 'result',
  audit,
}: {
  readonly runId: string;
  readonly tab?: RunTab;
  /** The Audit tab's content (`routes/runs.$runId.audit.tsx`). */
  readonly audit?: ReactNode;
}): ReactNode {
  const result = useRunResult(runId);
  useRunsChangeInvalidation();
  const [selected, setSelected] = useState<RunTab>(tab);

  if (result.isError) {
    const notFound = result.error instanceof RpcCallError && result.error.reason === 'not_found';
    return (
      <div className="flex flex-col gap-3">
        <h1 className="text-xl font-semibold text-ink">
          {notFound ? 'Run not found' : 'Couldn’t load this run'}
        </h1>
        <p className="text-ink-2">
          {notFound ? `There is no run ${runId}.` : result.error.message}
        </p>
        <div className="flex items-center gap-3">
          {notFound ? null : (
            <Button size="sm" icon="action.retry" onPress={() => void result.refetch()}>
              Retry
            </Button>
          )}
          <RouterLink to="/runs" className="text-accent-ink underline underline-offset-2">
            Back to the Ledger
          </RouterLink>
        </div>
      </div>
    );
  }
  if (result.data === undefined) {
    return (
      <p role="status" className="text-ink-2">
        Loading run…
      </p>
    );
  }
  const view = result.data;
  return (
    <div className="flex flex-col gap-6">
      <RunHeader view={view} />
      <Tabs
        selectedKey={selected}
        onSelectionChange={(key) => {
          setSelected(key as RunTab);
        }}
      >
        <TabList aria-label="Run views">
          <Tab id="result">Result</Tab>
          <Tab id="audit">Audit</Tab>
          <Tab id="files">Files</Tab>
        </TabList>
        <TabPanel id="result">
          <DocumentRegion view={view} />
        </TabPanel>
        <TabPanel id="audit">{audit ?? <p className="text-ink-2">{NOT_RECORDED}</p>}</TabPanel>
        <TabPanel id="files">
          <FilesRegion view={view} />
        </TabPanel>
      </Tabs>
    </div>
  );
}

function RunResultPage(): ReactNode {
  const { runId } = runRoute.useParams();
  return <RunPage runId={runId} />;
}

/** `/runs/$runId`. */
export const runRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/runs/$runId',
  component: RunResultPage,
});
