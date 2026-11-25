/**
 * The Ledger (`/runs`, FEAT-066 TASK-003): every run Yantra has recorded,
 * including CLI and daemon runs, in the Interface Study 01 layout.
 *
 * - **In progress** lists runs that have not ended: what each is doing, how
 *   long it has run, and the one thing to do next (Review when it needs you).
 * - **History** is a virtualized, cursor-paged Drshya Table, newest first:
 *   the outcome in a word, the goal over its run ID, when, how long, cost.
 * - Filters (outcome, mode, date range, text) live in the URL search params,
 *   written 250 ms after the last change, so a filtered view is a shareable
 *   in-app URL and survives a reload.
 * - New runs arrive through `runs.changed` without a reload and are announced
 *   in a polite live region; focus never moves.
 */

import { createRoute, Link as RouterLink, useNavigate } from '@tanstack/react-router';
import type {
  LedgerActiveRun,
  LedgerDisplayedState,
  LedgerMode,
  LedgerOutcomeFilter,
  ListRunItem,
} from '@yantra/protocol';
import {
  Bindu,
  Button,
  buttonStyles,
  Checkbox,
  cn,
  DISPLAYED_STATE_LABELS,
  Menu,
  MenuItem,
  MenuTrigger,
  OutcomeBadge,
  Select,
  Table,
  TextField,
  type BinduState,
  type TableColumn,
  type TableLoadState,
} from '@yantra/ui';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { rootRoute } from '../app/root-route.js';
import { PageHeader } from '../app/shell/PageHeader.js';
import { useRunLedger, useRunsChangeInvalidation, type LedgerFilters } from '../data/runs.js';
import {
  formatCost,
  formatDuration,
  formatTimestamp,
  formatWhen,
  NOT_RECORDED,
} from '../features/format.js';
import { formatElapsed, useElapsed } from '../features/live/tick-clock.js';

/** How long after the last filter change the URL is written. */
export const FILTER_DEBOUNCE_MS = 250;

/** The outcome filter choices: protocol ids, plain labels. */
export const OUTCOME_FILTERS: readonly {
  readonly id: LedgerOutcomeFilter;
  readonly label: string;
}[] = [
  { id: 'fulfilled', label: 'Fulfilled' },
  { id: 'partial', label: 'Partial' },
  { id: 'handoff', label: 'Handoff' },
  { id: 'failed', label: 'Failed' },
  { id: 'aborted', label: 'Aborted' },
  { id: 'unknown', label: 'Not recorded' },
];

const MODES: readonly { readonly id: LedgerMode; readonly label: string }[] = [
  { id: 'ask', label: 'Ask' },
  { id: 'research', label: 'Research' },
  { id: 'do', label: 'Do' },
  { id: 'run', label: 'Run' },
];
const ANY_MODE = 'any';
const DAY = /^\d{4}-\d{2}-\d{2}$/u;

/** Rows hold the goal over its run ID. */
const ROW_HEIGHT = 56;

/** Rows shown before History scrolls (and pages in more as it does). */
const VISIBLE_ROWS = 10;

/** History fits its rows, up to {@link VISIBLE_ROWS}; the header is one row tall. */
export function historyHeight(rows: number): string {
  const shown = Math.min(Math.max(rows, 1), VISIBLE_ROWS);
  return `${String((shown + 1) * ROW_HEIGHT + 2)}px`;
}

/** The Ledger's URL search params. */
export interface LedgerSearch {
  readonly outcome?: string;
  readonly mode?: string;
  readonly since?: string;
  readonly until?: string;
  readonly q?: string;
}

/** Keeps only well-formed search params; anything else is dropped, never an error. */
export function parseLedgerSearch(search: Record<string, unknown>): LedgerSearch {
  const text = (value: unknown): string | undefined =>
    typeof value === 'string' && value.length > 0 ? value : undefined;
  const outcome = text(search.outcome)
    ?.split(',')
    .filter((word) => OUTCOME_FILTERS.some((choice) => choice.id === word))
    .join(',');
  const mode = text(search.mode);
  const since = text(search.since);
  const until = text(search.until);
  const q = text(search.q)?.slice(0, 200);
  return {
    ...(outcome === undefined || outcome.length === 0 ? {} : { outcome }),
    ...(mode !== undefined && MODES.some((choice) => choice.id === mode) ? { mode } : {}),
    ...(since !== undefined && DAY.test(since) ? { since } : {}),
    ...(until !== undefined && DAY.test(until) ? { until } : {}),
    ...(q === undefined ? {} : { q }),
  };
}

/** The query filters a search describes. */
export function filtersFromSearch(search: LedgerSearch): LedgerFilters {
  return {
    ...(search.outcome === undefined
      ? {}
      : { outcome: search.outcome.split(',') as LedgerOutcomeFilter[] }),
    ...(search.mode === undefined ? {} : { mode: search.mode as LedgerMode }),
    ...(search.since === undefined ? {} : { since: search.since }),
    ...(search.until === undefined ? {} : { until: search.until }),
    ...(search.q === undefined ? {} : { text: search.q }),
  };
}

/** The search params for a set of filters (the inverse of {@link filtersFromSearch}). */
export function searchFromFilters(filters: LedgerFilters): LedgerSearch {
  return parseLedgerSearch({
    outcome: filters.outcome?.join(','),
    mode: filters.mode,
    since: filters.since,
    until: filters.until,
    q: filters.text,
  });
}

function hasFilters(search: LedgerSearch): boolean {
  return Object.keys(search).length > 0;
}

/** A mode in the label voice, or a dash. */
function ModeLabel({ mode }: { readonly mode: LedgerMode | undefined }): ReactNode {
  const label = MODES.find((choice) => choice.id === mode)?.label;
  return label === undefined ? (
    <span className="text-ink-3">{NOT_RECORDED}</span>
  ) : (
    <span className="type-label text-ink-2">{label}</span>
  );
}

/** The goal over the run ID. A workflow run's goal is the workflow's name, in the engine voice. */
function GoalCell({ run }: { readonly run: ListRunItem }): ReactNode {
  return (
    <span className="flex min-w-0 flex-1 flex-col">
      <span
        data-part="goal"
        title={run.workflowName}
        className={cn(
          'truncate text-ink',
          run.taskType === 'run' ? 'type-engine text-caption' : 'font-medium',
        )}
      >
        {run.workflowName}
      </span>
      <span className="truncate type-engine text-micro text-ink-3">{run.runId}</span>
    </span>
  );
}

/** When a run started, as a person says it; the full time on hover. */
function Started({ at }: { readonly at: string }): ReactNode {
  return (
    <time dateTime={at} title={formatTimestamp(at)}>
      {formatWhen(at)}
    </time>
  );
}

/** A run's actions: Open, plus run it again from the composer. */
function RowActions({ runId }: { readonly runId: string }): ReactNode {
  const navigate = useNavigate();
  return (
    <span className="flex items-center gap-1">
      <RouterLink
        to="/runs/$runId"
        params={{ runId }}
        className={buttonStyles({ size: 'sm', variant: 'secondary' })}
      >
        Open
      </RouterLink>
      <MenuTrigger>
        <Button
          size="sm"
          variant="quiet"
          icon="action.more"
          aria-label={`More actions for ${runId}`}
        />
        <Menu
          aria-label={`More actions for ${runId}`}
          onAction={(key) => {
            if (key === 'open') void navigate({ to: '/runs/$runId', params: { runId } });
            if (key === 'again')
              void navigate({ to: '/mission', search: { from: runId, settings: 'current' } });
          }}
        >
          <MenuItem id="open">Open the result</MenuItem>
          <MenuItem id="again">Run again…</MenuItem>
        </Menu>
      </MenuTrigger>
    </span>
  );
}

const COLUMNS: readonly TableColumn<ListRunItem>[] = [
  {
    id: 'outcome',
    header: 'Outcome',
    width: 168,
    cell: (run) => (
      <OutcomeBadge
        status={run.status}
        taskOutcome={run.taskOutcome}
        executionState={run.executionState}
        wording="plain"
      />
    ),
  },
  { id: 'goal', header: 'Goal', isRowHeader: true, cell: (run) => <GoalCell run={run} /> },
  { id: 'mode', header: 'Mode', width: 108, cell: (run) => <ModeLabel mode={run.taskType} /> },
  { id: 'started', header: 'Started', width: 176, cell: (run) => <Started at={run.startedAt} /> },
  {
    id: 'duration',
    header: 'Duration',
    width: 120,
    align: 'end',
    voice: 'engine',
    cell: (run) => formatDuration(run.durationMs),
  },
  {
    id: 'cost',
    header: 'Cost',
    width: 88,
    align: 'end',
    voice: 'engine',
    cell: (run) => formatCost(run.costUsd),
  },
  { id: 'actions', header: 'Actions', width: 132, cell: (run) => <RowActions runId={run.runId} /> },
];

function FilterBar({
  search,
  onChange,
}: {
  readonly search: LedgerSearch;
  readonly onChange: (next: LedgerSearch) => void;
}): ReactNode {
  const [draft, setDraft] = useState<LedgerSearch>(search);
  const committed = useRef(JSON.stringify(search));
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // The URL changed from outside (back, a shared link): show what it says.
  useEffect(() => {
    const incoming = JSON.stringify(search);
    if (incoming !== committed.current) {
      committed.current = incoming;
      setDraft(search);
    }
  }, [search]);

  // Write the URL once the filters have been still for 250 ms.
  useEffect(() => {
    const serialized = JSON.stringify(draft);
    if (serialized === committed.current) return undefined;
    const timer = window.setTimeout(() => {
      committed.current = serialized;
      onChangeRef.current(draft);
    }, FILTER_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [draft]);

  const outcomes = new Set(draft.outcome?.split(',') ?? []);
  const update = (patch: Partial<Record<keyof LedgerSearch, string | undefined>>): void => {
    setDraft((current) => parseLedgerSearch({ ...current, ...patch }));
  };

  return (
    <form
      role="search"
      aria-label="Filter runs"
      className="flex flex-wrap items-end gap-x-5 gap-y-4 rounded-control border border-rule bg-surface px-4 py-3.5"
      onSubmit={(event) => {
        event.preventDefault();
      }}
    >
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 type-label text-ink-3">Outcome</legend>
        <div className="flex flex-wrap gap-1.5">
          {OUTCOME_FILTERS.map((choice) => (
            <Checkbox
              key={choice.id}
              appearance="chip"
              isSelected={outcomes.has(choice.id)}
              onChange={(selected) => {
                const next = new Set(outcomes);
                if (selected) next.add(choice.id);
                else next.delete(choice.id);
                update({
                  outcome: OUTCOME_FILTERS.filter((item) => next.has(item.id))
                    .map((item) => item.id)
                    .join(','),
                });
              }}
            >
              {choice.label}
            </Checkbox>
          ))}
        </div>
      </fieldset>
      <Select
        label="Mode"
        className="w-36"
        options={[{ id: ANY_MODE, label: 'Any mode' }, ...MODES]}
        selectedKey={draft.mode ?? ANY_MODE}
        onSelectionChange={(key) => {
          update({ mode: key === ANY_MODE || key === null ? undefined : String(key) });
        }}
      />
      <TextField
        label="From"
        type="date"
        className="w-40"
        value={draft.since ?? ''}
        onChange={(value) => {
          update({ since: value });
        }}
      />
      <TextField
        label="To"
        type="date"
        className="w-40"
        value={draft.until ?? ''}
        onChange={(value) => {
          update({ until: value });
        }}
      />
      <TextField
        label="Search"
        type="search"
        className="min-w-56 flex-1"
        placeholder="Goal, workflow or run ID"
        value={draft.q ?? ''}
        onChange={(value) => {
          update({ q: value });
        }}
      />
    </form>
  );
}

/** A displayed state that means the run waits on you. */
function needsYou(state: LedgerDisplayedState): boolean {
  return state === 'waiting_for_you' || state === 'needs_review';
}

/** A displayed state that means Yantra cannot tell how the run is doing. */
function inDoubt(state: LedgerDisplayedState): boolean {
  return (
    state === 'start_outcome_unknown' ||
    state === 'worker_not_responding' ||
    state === 'unknown_owner'
  );
}

function binduFor(state: LedgerDisplayedState): BinduState {
  if (needsYou(state)) return 'needs_you';
  return state === 'running' ? 'acting' : 'live';
}

/** What an in-progress run is doing, in words. */
export function activeStatusLine(state: LedgerDisplayedState): string {
  const label = DISPLAYED_STATE_LABELS[state];
  const said = `${label.charAt(0).toUpperCase()}${label.slice(1)}`;
  if (state === 'waiting_for_you') return `${said} · answer it in the Inbox`;
  if (state === 'needs_review') return `${said} · its settings changed since you started it`;
  return said;
}

function ActiveCard({ run }: { readonly run: LedgerActiveRun }): ReactNode {
  const elapsed = useElapsed(run.startedAt, null);
  const waiting = needsYou(run.displayedState);
  return (
    <li
      className={cn(
        'flex flex-wrap items-center gap-x-5 gap-y-2 rounded-control border bg-surface px-4 py-3.5',
        waiting ? 'border-signal-needs-you' : 'border-rule',
      )}
    >
      <Bindu
        state={binduFor(run.displayedState)}
        label={`Run status: ${DISPLAYED_STATE_LABELS[run.displayedState]}`}
      />
      <span className="w-20">
        <ModeLabel mode={run.taskType} />
      </span>
      <span className="flex min-w-0 flex-[1_1_20rem] flex-col">
        <RouterLink
          to="/runs/$runId"
          params={{ runId: run.runId }}
          className="truncate font-medium text-ink hover:underline focus-visible:outline-2 focus-visible:outline-accent"
        >
          {run.workflowName}
        </RouterLink>
        <span
          className={cn(
            'text-caption',
            waiting
              ? 'font-semibold text-signal-needs-you-ink'
              : inDoubt(run.displayedState)
                ? 'text-signal-partial-ink'
                : 'text-ink-3',
          )}
        >
          {activeStatusLine(run.displayedState)}
        </span>
      </span>
      <span className="w-16 text-right type-engine text-caption text-ink-2">
        <span className="sr-only">Running for </span>
        {elapsed === null ? NOT_RECORDED : formatElapsed(elapsed)}
      </span>
      {waiting ? (
        <RouterLink to="/inbox" className={buttonStyles({ size: 'sm', variant: 'primary' })}>
          Review
        </RouterLink>
      ) : (
        <RouterLink
          to="/runs/$runId"
          params={{ runId: run.runId }}
          className={buttonStyles({ size: 'sm', variant: 'secondary' })}
        >
          Open
        </RouterLink>
      )}
    </li>
  );
}

function InProgress({ runs }: { readonly runs: readonly LedgerActiveRun[] }): ReactNode {
  return (
    <section aria-labelledby="ledger-active" className="flex flex-col gap-3">
      <div className="flex items-baseline gap-2.5">
        <h2 id="ledger-active" className="type-section text-ink">
          In progress
        </h2>
        {runs.length === 0 ? null : (
          <span className="type-engine text-caption text-ink-3">{runs.length}</span>
        )}
      </div>
      {runs.length === 0 ? (
        <p className="text-ink-2">No runs in progress.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {runs.map((run) => (
            <ActiveCard key={run.runId} run={run} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** The Ledger page for one set of search params. */
export function LedgerView({
  search,
  onSearchChange,
}: {
  readonly search: LedgerSearch;
  readonly onSearchChange: (next: LedgerSearch) => void;
}): ReactNode {
  const filters = useMemo(() => filtersFromSearch(search), [search]);
  const ledger = useRunLedger(filters);
  const announcement = useRunsChangeInvalidation();
  const navigate = useNavigate();

  const loadState: TableLoadState = ledger.isFetchingNextPage
    ? 'loading'
    : ledger.isFetchNextPageError
      ? 'error'
      : ledger.hasNextPage
        ? 'idle'
        : 'exhausted';

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow="Runs"
        title="Ledger"
        description="Every run on this machine, newest first. Open one to read its result, its evidence and its audit."
        actions={
          <RouterLink to="/mission" className={buttonStyles({ variant: 'primary' })}>
            Start a run
          </RouterLink>
        }
      />
      <div role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>
      <FilterBar search={search} onChange={onSearchChange} />
      {ledger.source === 'files' ? (
        <p role="note" className="text-ink-2">
          History index unavailable — showing runs from files only. Run `yantra doctor` to rebuild
          the index.
        </p>
      ) : null}
      {ledger.scanTruncated ? (
        <p role="note" className="text-ink-2">
          Showing the newest runs; refine filters to search further.
        </p>
      ) : null}
      <InProgress runs={ledger.active} />
      <section aria-labelledby="ledger-history" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline gap-x-3.5 gap-y-1">
          <h2 id="ledger-history" className="type-section text-ink">
            History
          </h2>
          <span className="type-engine text-caption text-ink-3">yantra list</span>
        </div>
        {ledger.isError && ledger.data === undefined ? (
          <div className="flex items-center gap-3">
            <p className="text-signal-failed-ink">Couldn’t load runs.</p>
            <Button
              size="sm"
              icon="action.retry"
              onPress={() => {
                void ledger.refetch();
              }}
            >
              Retry
            </Button>
          </div>
        ) : (
          <Table
            aria-labelledby="ledger-history"
            columns={COLUMNS}
            rows={ledger.rows}
            getRowKey={(run) => run.runId}
            rowHeight={ROW_HEIGHT}
            height={historyHeight(ledger.rows.length + (ledger.hasNextPage ? VISIBLE_ROWS : 0))}
            // The first page shows the empty state's "Loading runs…", not a load-more row.
            loadState={ledger.isPending ? 'exhausted' : loadState}
            onLoadMore={() => {
              // A second call while a page is in flight joins it, never refetches.
              if (ledger.hasNextPage) void ledger.fetchNextPage({ cancelRefetch: false });
            }}
            onRowAction={(runId) => {
              void navigate({ to: '/runs/$runId', params: { runId } });
            }}
            emptyState={
              ledger.isPending
                ? 'Loading runs…'
                : hasFilters(search)
                  ? 'No runs match these filters.'
                  : 'No runs yet.'
            }
          />
        )}
      </section>
    </div>
  );
}

function LedgerPage(): ReactNode {
  const search = ledgerRoute.useSearch();
  const navigate = useNavigate({ from: '/runs' });
  return (
    <LedgerView
      search={search}
      onSearchChange={(next) => {
        void navigate({ search: next, replace: true });
      }}
    />
  );
}

/** `/runs`. */
export const ledgerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/runs',
  validateSearch: parseLedgerSearch,
  component: LedgerPage,
});
