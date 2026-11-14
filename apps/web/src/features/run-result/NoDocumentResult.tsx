/**
 * The Result tab of a run that saved no Brief or document (FEAT-066
 * TASK-007): a zero-synthesis workflow, a failure before the Brief, or an
 * interrupted or legacy run. Every region renders a value or an explicit
 * "not recorded" state, so the page is always complete:
 *
 * 1. the outcome, termination reason and execution state;
 * 2. why the run ended, with the source that recorded it;
 * 3. the workflow outputs (JSON viewer) or their slot state;
 * 4. run health, worded as `report.md` words it;
 * 5. notices; 6. `report.md`, loaded lazily, with a truncation banner;
 * 7. the run's files.
 */

import type { RunResultView, TerminalReason } from '@yantra/protocol';
import { OutcomeBadge, SafeMarkdown } from '@yantra/ui';
import type { ReactNode } from 'react';

import { useReport } from '../../data/runs.js';
import { formatBytes } from '../format.js';
import { JsonViewer } from '../viewers/JsonViewer.js';
import { ShowInFolder } from '../viewers/ShowInFolder.js';

import { liveDisplayedState } from './live-state.js';
import { runHealthLines } from './run-health-lines.js';
import { SlotState } from './SlotState.js';

/** Where each terminal-reason source lives, for the provenance line. */
export const TERMINAL_SOURCE_TEXT: Readonly<Record<TerminalReason['source'], string>> = {
  run_outcome: 'the run-event stream (run-events.jsonl)',
  manifest: 'manifest.json',
  events: 'events.jsonl',
  report: 'report.md',
};

/** What an interrupted run reads like (FEAT-064 D7). */
export const INTERRUPTED_TEXT = 'The run’s owner stopped before it finished.';

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
    <section aria-labelledby={id} data-region={id} className="flex flex-col gap-2">
      <h2 id={id} className="text-lg font-semibold text-ink">
        {heading}
      </h2>
      {children}
    </section>
  );
}

function NotRecorded({ children }: { readonly children: ReactNode }): ReactNode {
  return <p className="text-ink-2">{children}</p>;
}

function OutcomeRegion({ view }: { readonly view: RunResultView }): ReactNode {
  return (
    <Region id="outcome" heading="Outcome">
      <div className="flex flex-wrap items-center gap-3">
        <OutcomeBadge
          status={view.status}
          taskOutcome={view.task_outcome ?? undefined}
          executionState={view.execution_state ?? undefined}
          displayedState={liveDisplayedState(view)}
        />
        {view.termination_reason === null ? null : (
          <span className="text-ink-2">
            stopped: <span className="type-engine text-ink">{view.termination_reason}</span>
          </span>
        )}
      </div>
      {view.execution_state === 'interrupted' ? (
        <p data-part="interrupted" className="text-ink">
          {INTERRUPTED_TEXT}{' '}
          {view.task_outcome === null
            ? 'No outcome was recorded.'
            : `The outcome follows the evidence it left: ${view.task_outcome}.`}
        </p>
      ) : null}
    </Region>
  );
}

function TerminalRegion({ terminal }: { readonly terminal: TerminalReason | null }): ReactNode {
  if (terminal === null) {
    return (
      <Region id="terminal" heading="Why it ended">
        <NotRecorded>No reason was recorded for how this run ended.</NotRecorded>
      </Region>
    );
  }
  const rows: [string, string | undefined][] = [
    ['Failure class', terminal.failure_class],
    ['Message', terminal.message],
    ['Blocker', terminal.blocker],
    ['Safest next action', terminal.safest_next_action],
    ['Termination reason', terminal.termination_reason],
  ];
  const shown = rows.filter((row): row is [string, string] => row[1] !== undefined);
  return (
    <Region id="terminal" heading="Why it ended">
      {shown.length === 0 ? (
        <NotRecorded>No reason was recorded for how this run ended.</NotRecorded>
      ) : (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
          {shown.map(([term, value]) => (
            <div key={term} className="contents">
              <dt className="type-label text-ink-2">{term}</dt>
              <dd className="text-ink">{value}</dd>
            </div>
          ))}
        </dl>
      )}
      <p data-part="provenance" className="text-caption text-ink-2">
        Recorded in {TERMINAL_SOURCE_TEXT[terminal.source]}
      </p>
    </Region>
  );
}

function OutputsRegion({ view }: { readonly view: RunResultView }): ReactNode {
  const outputs = view.outputs;
  if (outputs === null) return null;
  return (
    <Region id="outputs" heading="Outputs">
      {outputs.state === 'ok' ? (
        Object.keys(outputs.value).length === 0 ? (
          <NotRecorded>The workflow declared no outputs.</NotRecorded>
        ) : (
          <JsonViewer value={outputs.value} label="Workflow outputs" />
        )
      ) : (
        <SlotState slot={outputs} label="outputs" runId={view.run_id} artifacts={view.artifacts} />
      )}
    </Region>
  );
}

function HealthRegion({ view }: { readonly view: RunResultView }): ReactNode {
  const health = view.run_health;
  return (
    <Region id="run-health" heading="Run health">
      {health.state === 'ok' ? (
        <ul className="flex flex-col gap-1">
          {runHealthLines(health.value).map((line) => (
            <li key={line} className="type-engine text-ink">
              {line}
            </li>
          ))}
        </ul>
      ) : health.state === 'missing' ? (
        <NotRecorded>No run health was recorded for this run.</NotRecorded>
      ) : (
        <SlotState
          slot={health}
          label="run health"
          runId={view.run_id}
          artifacts={view.artifacts}
        />
      )}
    </Region>
  );
}

function NoticesRegion({ view }: { readonly view: RunResultView }): ReactNode {
  const count =
    view.notices_source === 'run_health' && view.run_health.state === 'ok'
      ? view.run_health.value.notices
      : 0;
  return (
    <Region id="notices" heading="Notices">
      {count === 0 ? (
        <NotRecorded>No notices recorded.</NotRecorded>
      ) : (
        <p className="text-ink">
          {count === 1 ? '1 notice was' : `${String(count)} notices were`} recorded; report.md lists
          them.
        </p>
      )}
    </Region>
  );
}

function ReportRegion({ view }: { readonly view: RunResultView }): ReactNode {
  const report = useReport(view.run_id, view.report.exists);
  return (
    <Region id="report" heading="report.md">
      {!view.report.exists ? (
        <NotRecorded>No report.md was recorded for this run.</NotRecorded>
      ) : report.isError ? (
        <NotRecorded>{report.error.message}</NotRecorded>
      ) : report.data === undefined ? (
        <p role="status" className="text-ink-2">
          Loading report.md…
        </p>
      ) : (
        <>
          {report.data.truncated === true ? (
            <div
              role="note"
              data-part="truncated"
              className="flex flex-col gap-2 rounded-control border border-rule bg-sunken p-3"
            >
              <p className="text-ink">
                Showing the first part of report.md; the whole file is{' '}
                {formatBytes(report.data.bytes ?? view.report.bytes)}.
              </p>
              <ShowInFolder runId={view.run_id} />
            </div>
          ) : null}
          <SafeMarkdown>{report.data.markdown}</SafeMarkdown>
        </>
      )}
    </Region>
  );
}

/** See the module comment. */
export function NoDocumentResult({
  view,
  files,
}: {
  readonly view: RunResultView;
  /** The run's file list (the Files region). */
  readonly files: ReactNode;
}): ReactNode {
  return (
    <div data-document="none" className="flex flex-col gap-6">
      <OutcomeRegion view={view} />
      <TerminalRegion terminal={view.terminal} />
      <OutputsRegion view={view} />
      <HealthRegion view={view} />
      <NoticesRegion view={view} />
      <ReportRegion view={view} />
      <Region id="artifacts" heading="Files">
        {files}
      </Region>
    </div>
  );
}
