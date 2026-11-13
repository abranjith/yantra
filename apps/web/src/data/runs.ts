/**
 * React Query hooks over the host's run reads (FEAT-066).
 *
 * Query keys: `['ledger', filters]` (infinite), `['run', runId]`,
 * `['audit', runId, window]`, `['report', runId]`,
 * `['jsonl', runId, path, fromLine]`.
 *
 * A `runs.changed` hint refreshes the Ledger's **first page only** and merges
 * it into what is already loaded, de-duplicated by run id. Re-paging every
 * loaded page by keyset after new runs arrive would skip the rows pushed
 * across a page boundary; merging keeps every row, and the loaded cursor still
 * continues exactly where it left off.
 */

import {
  useInfiniteQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from '@tanstack/react-query';
import type {
  LedgerActiveRun,
  LedgerMode,
  LedgerOutcomeFilter,
  ListRunItem,
  RunLedgerPage,
} from '@yantra/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useRpc, type AppRpc } from '../host/app-rpc.js';

/** Rows per Ledger page. */
export const LEDGER_PAGE_SIZE = 50;

/** The Ledger filters, mirrored in the route's search params. */
export interface LedgerFilters {
  readonly outcome?: readonly LedgerOutcomeFilter[];
  readonly mode?: LedgerMode;
  /** `YYYY-MM-DD`, inclusive, in the viewer's time zone. */
  readonly since?: string;
  /** `YYYY-MM-DD`, inclusive, in the viewer's time zone. */
  readonly until?: string;
  readonly text?: string;
}

/** The query key of the Ledger for `filters`. */
export function ledgerKey(filters: LedgerFilters): readonly unknown[] {
  return ['ledger', filters];
}

/** Local midnight of a `YYYY-MM-DD` day as an ISO instant, or undefined when invalid. */
export function dayStart(day: string | undefined, offsetDays = 0): string | undefined {
  if (day === undefined || !/^\d{4}-\d{2}-\d{2}$/u.test(day)) return undefined;
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  const instant = new Date(year, month - 1, date + offsetDays);
  return Number.isNaN(instant.getTime()) ? undefined : instant.toISOString();
}

/** The `read.list` params for one page of `filters`. */
export function ledgerParams(
  filters: LedgerFilters,
  cursor: string | undefined,
): Record<string, unknown> {
  const since = dayStart(filters.since);
  const until = dayStart(filters.until, 1);
  return {
    target: 'runs',
    limit: LEDGER_PAGE_SIZE,
    ...(cursor === undefined ? {} : { cursor }),
    ...(filters.outcome === undefined || filters.outcome.length === 0
      ? {}
      : { outcome: [...filters.outcome] }),
    ...(filters.mode === undefined ? {} : { mode: [filters.mode] }),
    ...(since === undefined ? {} : { since }),
    ...(until === undefined ? {} : { until }),
    ...(filters.text === undefined || filters.text.length === 0 ? {} : { text: filters.text }),
  };
}

/** Every loaded History row, in order, once each. */
export function ledgerRows(data: InfiniteData<RunLedgerPage> | undefined): ListRunItem[] {
  const seen = new Set<string>();
  const rows: ListRunItem[] = [];
  for (const page of data?.pages ?? []) {
    for (const item of page.items) {
      if (seen.has(item.runId)) continue;
      seen.add(item.runId);
      rows.push(item);
    }
  }
  return rows;
}

/** `a` before `b` in `startedAt DESC, runId DESC` order. */
function newestFirst(a: ListRunItem, b: ListRunItem): number {
  if (a.startedAt !== b.startedAt) return a.startedAt > b.startedAt ? -1 : 1;
  return a.runId > b.runId ? -1 : a.runId < b.runId ? 1 : 0;
}

/**
 * Merges a fresh first page into the loaded first page: fresh rows replace
 * their old versions, rows still loaded are kept, and the loaded cursor stays,
 * so the next page continues where it did.
 */
export function mergeFirstPage(fresh: RunLedgerPage, loaded: RunLedgerPage): RunLedgerPage {
  const byId = new Map<string, ListRunItem>();
  for (const item of loaded.items) byId.set(item.runId, item);
  for (const item of fresh.items) byId.set(item.runId, item);
  const activeIds = new Set(fresh.active.map((run) => run.runId));
  const items = [...byId.values()].filter((item) => !activeIds.has(item.runId)).sort(newestFirst);
  return { ...fresh, items, next_cursor: loaded.next_cursor };
}

/** Fetches one Ledger page. */
export function fetchLedgerPage(
  rpc: AppRpc,
  filters: LedgerFilters,
  cursor: string | undefined,
): Promise<RunLedgerPage> {
  return rpc.request<RunLedgerPage>('read.list', ledgerParams(filters, cursor));
}

/** The Ledger: History pages plus the Active region of the first page. */
export function useRunLedger(filters: LedgerFilters) {
  const rpc = useRpc();
  const query = useInfiniteQuery({
    queryKey: ledgerKey(filters),
    queryFn: ({ pageParam }) => fetchLedgerPage(rpc, filters, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
  const first = query.data?.pages[0];
  return {
    ...query,
    rows: ledgerRows(query.data),
    active: first?.active ?? ([] as LedgerActiveRun[]),
    source: first?.source ?? 'index',
    scanTruncated: query.data?.pages.some((page) => page.scan_truncated === true) ?? false,
  };
}

/**
 * Refreshes page one of every loaded Ledger and merges it in. Returns how many
 * runs appeared that were not shown before.
 */
export async function refreshLedgerFirstPages(
  rpc: AppRpc,
  queryClient: QueryClient,
): Promise<number> {
  let added = 0;
  const loaded = queryClient.getQueriesData<InfiniteData<RunLedgerPage>>({ queryKey: ['ledger'] });
  for (const [key, data] of loaded) {
    if (data === undefined || data.pages.length === 0) continue;
    const filters = (key[1] ?? {}) as LedgerFilters;
    const fresh = await fetchLedgerPage(rpc, filters, undefined);
    const known = new Set([
      ...ledgerRows(data).map((row) => row.runId),
      ...data.pages[0]!.active.map((run) => run.runId),
    ]);
    added += [...fresh.items, ...fresh.active].filter((row) => !known.has(row.runId)).length;
    queryClient.setQueryData<InfiniteData<RunLedgerPage>>(key, (current) =>
      current === undefined || current.pages.length === 0
        ? current
        : {
            pages: [mergeFirstPage(fresh, current.pages[0]!), ...current.pages.slice(1)],
            pageParams: current.pageParams,
          },
    );
  }
  return added;
}

/**
 * Follows `runs.changed`: refreshes the Ledger's first page and invalidates
 * every touched run. Returns the polite announcement for new runs.
 */
export function useRunsChangeInvalidation(): string {
  const rpc = useRpc();
  const queryClient = useQueryClient();
  const [announcement, setAnnouncement] = useState('');
  const busy = useRef(false);
  const again = useRef(false);

  const refresh = useCallback(async (): Promise<void> => {
    if (busy.current) {
      // A hint during a refresh means one more refresh afterwards, never a lost change.
      again.current = true;
      return;
    }
    busy.current = true;
    try {
      do {
        again.current = false;
        const added = await refreshLedgerFirstPages(rpc, queryClient).catch(() => 0);
        if (added > 0) setAnnouncement(added === 1 ? '1 new run' : `${String(added)} new runs`);
      } while (again.current);
    } finally {
      busy.current = false;
    }
  }, [rpc, queryClient]);

  const onChanged = useCallback(
    (params: Record<string, unknown>) => {
      const runIds = Array.isArray(params.run_ids)
        ? params.run_ids.filter((id): id is string => typeof id === 'string')
        : [];
      for (const runId of runIds) void queryClient.invalidateQueries({ queryKey: ['run', runId] });
      void refresh();
    },
    [queryClient, refresh],
  );

  useEffect(() => {
    rpc.subscribe('runs.subscribe');
    return rpc.on('runs.changed', onChanged);
  }, [rpc, onChanged]);

  return announcement;
}
