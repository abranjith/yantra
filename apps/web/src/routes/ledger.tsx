/**
 * The Ledger (`/runs`, FEAT-066 TASK-003): every run Yantra has recorded,
 * including CLI and daemon runs.
 *
 * - **Active** lists runs that have not ended, with their displayed state.
 * - **History** is a virtualized, cursor-paged Drshya Table, newest first.
 * - Filters (outcome, mode, date range, text) live in the URL search params,
 *   written 250 ms after the last change, so a filtered view is a shareable
 *   in-app URL and survives a reload.
 * - New runs arrive through `runs.changed` without a reload and are announced
 *   in a polite live region; focus never moves.
 */

import { createRoute, Link as RouterLink, useNavigate } from '@tanstack/react-router';
import type { LedgerMode, LedgerOutcomeFilter, ListRunItem } from '@yantra/protocol';
import {
  Button,
  Checkbox,
  OutcomeBadge,
  Select,
  Table,
  TextField,
  type TableColumn,
  type TableLoadState,
} from '@yantra/ui';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { rootRoute } from '../app/root-route.js';
import { useRunLedger, useRunsChangeInvalidation, type LedgerFilters } from '../data/runs.js';
import { formatCost, formatDuration, formatTimestamp, NOT_RECORDED } from '../features/format.js';

/** How long after the last filter change the URL is written. */
export const FILTER_DEBOUNCE_MS = 250;

/** The outcome filter choices, in the protocol's words. */
export const OUTCOME_FILTERS: readonly {
  readonly id: LedgerOutcomeFilter;
  readonly label: string;
}[] = [
  { id: 'fulfilled', label: 'fulfilled' },
  { id: 'partial', label: 'partial' },
  { id: 'handoff', label: 'handoff' },
  { id: 'failed', label: 'failed' },
  { id: 'aborted', label: 'aborted' },
  { id: 'unknown', label: 'no outcome recorded' },
];

const MODES: readonly LedgerMode[] = ['ask', 'research', 'do', 'run'];
const ANY_MODE = 'any';
const DAY = /^\d{4}-\d{2}-\d{2}$/u;

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
    ...(mode !== undefined && (MODES as readonly string[]).includes(mode) ? { mode } : {}),
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

const COLUMNS: readonly TableColumn<ListRunItem>[] = [
  {
    id: 'outcome',
    header: 'Outcome',
    width: 220,
    cell: (run) => (
      <OutcomeBadge
        status={run.status}
        taskOutcome={run.taskOutcome}
        executionState={run.executionState}
      />
    ),
  },
  { id: 'title', header: 'Title', isRowHeader: true, cell: (run) => run.workflowName },
  { id: 'mode', header: 'Mode', width: 96, cell: (run) => run.taskType ?? NOT_RECORDED },
  { id: 'started', header: 'Started', width: 180, cell: (run) => formatTimestamp(run.startedAt) },
  {
    id: 'duration',
    header: 'Duration',
    width: 110,
    align: 'end',
    cell: (run) => formatDuration(run.durationMs),
  },
  { id: 'cost', header: 'Cost', width: 90, align: 'end', cell: (run) => formatCost(run.costUsd) },
  { id: 'run', header: 'Run ID', voice: 'engine', cell: (run) => run.runId },
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
      className="flex flex-wrap items-end gap-4"
      onSubmit={(event) => {
        event.preventDefault();
      }}
    >
      <fieldset className="flex flex-col gap-1.5">
        <legend className="type-label text-ink-2">Outcome</legend>
        <div className="flex flex-wrap gap-3">
          {OUTCOME_FILTERS.map((choice) => (
            <Checkbox
              key={choice.id}
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
        className="w-40"
        options={[
          { id: ANY_MODE, label: 'Any mode' },
          ...MODES.map((mode) => ({ id: mode, label: mode })),
        ]}
        selectedKey={draft.mode ?? ANY_MODE}
        onSelectionChange={(key) => {
          update({ mode: key === ANY_MODE || key === null ? undefined : String(key) });
        }}
      />
      <TextField
        label="From"
        type="date"
        className="w-44"
        value={draft.since ?? ''}
        onChange={(value) => {
          update({ since: value });
        }}
      />
      <TextField
        label="To"
        type="date"
        className="w-44"
        value={draft.until ?? ''}
        onChange={(value) => {
          update({ until: value });
        }}
      />
      <TextField
        label="Search"
        type="search"
        className="w-64"
        placeholder="Goal, workflow or run ID"
        value={draft.q ?? ''}
        onChange={(value) => {
          update({ q: value });
        }}
      />
    </form>
  );
}

function ActiveRegion({ runs }: { readonly runs: ReturnType<typeof useRunLedger>['active'] }) {
  return (
    <section aria-labelledby="ledger-active" className="flex flex-col gap-2">
      <h2 id="ledger-active" className="text-lg font-semibold text-ink">
        Active
      </h2>
      {runs.length === 0 ? (
        <p className="text-ink-2">No runs in progress.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {runs.map((run) => (
            <li key={run.runId} className="flex flex-wrap items-center gap-3">
              <OutcomeBadge
                status={run.status}
                taskOutcome={run.taskOutcome}
                displayedState={run.displayedState}
              />
              <RouterLink
                to="/runs/$runId"
                params={{ runId: run.runId }}
                className="text-accent-ink underline underline-offset-2"
              >
                {run.workflowName}
              </RouterLink>
              <span className="text-ink-2">{formatTimestamp(run.startedAt)}</span>
              <span className="type-engine text-ink-2">{run.runId}</span>
            </li>
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
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold text-ink">Ledger</h1>
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
      <ActiveRegion runs={ledger.active} />
      <section aria-labelledby="ledger-history" className="flex flex-col gap-2">
        <h2 id="ledger-history" className="text-lg font-semibold text-ink">
          History
        </h2>
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
            height="32rem"
            loadState={ledger.isPending ? 'loading' : loadState}
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
