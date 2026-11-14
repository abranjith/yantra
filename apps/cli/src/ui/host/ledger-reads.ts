/**
 * `read.list` (FEAT-066 TASK-002): the app's Ledger page.
 *
 * Target `runs` takes a {@link RunLedgerQuery} and returns a
 * {@link RunLedgerPage} from `queryRunLedger`, the same core function
 * `yantra list` uses, after the same FEAT-064 reconciliation. Target
 * `workflows` returns the `list workflows --json` document unchanged.
 *
 * The active region merges what the host knows (its own invocations and the
 * change feed's leased runs) with the ledger's manifest scan. A page never
 * exceeds {@link MAX_LEDGER_PAGE_BYTES}: an oversized page is shortened and
 * its cursor continues from the last row that fits.
 */

import {
  decodeLedgerCursor,
  encodeLedgerCursor,
  LedgerCursorError,
  queryRunLedger,
  reconcileAll,
  runsRoot,
  type ActiveRun,
  type HistoryStore,
  type LedgerKey,
  type Logger,
} from '@yantra/core';
import {
  CLI_READ_SCHEMA_VERSION,
  ListResult,
  ReadListParams,
  RunLedgerPage,
  type InvocationRecord,
  type LedgerDisplayedState,
  type ListRunItem,
  type RunLedgerQuery,
} from '@yantra/protocol';
import { z } from 'zod';

import { RpcError, type RpcMethodRegistry } from './rpc-server.js';

/** The largest serialized Ledger page (plan §7: under the 1 MiB message limit). */
export const MAX_LEDGER_PAGE_BYTES = 768 * 1024;

/** UTF-8 size of a value's JSON. */
export function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/** The `read.list` result: a Ledger page, or the workflow list. */
export const ReadListResult = z.union([RunLedgerPage, ListResult]);
export type ReadListResult = z.infer<typeof ReadListResult>;

/** What `read.list` needs from the host. */
export interface LedgerReadDeps {
  /** Reconciliation's logger; never receives run content. */
  readonly logger?: Logger;
  /** Opens the history index, or null when it is unavailable. */
  readonly openHistory: () => Promise<{
    readonly store: HistoryStore;
    close(): void;
  } | null>;
  /** Runs the host knows are in progress. */
  readonly activeRuns?: () => Promise<readonly ActiveRun[]>;
  /** The `list workflows --json` document. */
  readonly listWorkflows: () => Promise<ListResult>;
  /** Defaults to `runsRoot()`. */
  readonly runsDir?: string;
  /** Defaults to FEAT-064 `reconcileAll`, as `yantra list` runs it. */
  readonly reconcile?: (history: HistoryStore | null) => Promise<void>;
}

const INVOCATION_STATES: Readonly<
  Partial<Record<InvocationRecord['state'], LedgerDisplayedState>>
> = {
  queued: 'queued',
  reserved: 'starting',
  spawning: 'starting',
  claimed: 'starting',
  running: 'running',
  needs_review: 'needs_review',
  start_unknown: 'start_outcome_unknown',
};

/** The displayed state of an app invocation that names a run, or null once it ended. */
export function displayedStateOf(record: InvocationRecord): LedgerDisplayedState | null {
  return INVOCATION_STATES[record.state] ?? null;
}

/**
 * The host's view of runs in progress: its invocations that name a run, then
 * runs with a lease (the change feed), which read `running`.
 */
export function hostActiveRuns(sources: {
  readonly invocations: () => Promise<readonly InvocationRecord[]>;
  readonly leasedRunIds: () => readonly string[];
}): () => Promise<readonly ActiveRun[]> {
  return async () => {
    const active = new Map<string, ActiveRun>();
    for (const record of await sources.invocations().catch(() => [])) {
      const state = displayedStateOf(record);
      if (record.run_id === null || state === null) continue;
      active.set(record.run_id, { runId: record.run_id, displayedState: state });
    }
    for (const runId of sources.leasedRunIds()) {
      if (!active.has(runId)) active.set(runId, { runId, displayedState: 'running' });
    }
    return [...active.values()];
  };
}

function cursorKey(cursor: string): LedgerKey {
  try {
    return decodeLedgerCursor(cursor);
  } catch (error) {
    if (error instanceof LedgerCursorError) {
      throw new RpcError(
        'invalid_params',
        'The cursor is not one this host issued.',
        'Start again without a cursor.',
      );
    }
    throw error;
  }
}

/** One Ledger page for `query`. */
export async function readLedgerPage(
  query: RunLedgerQuery,
  deps: LedgerReadDeps,
): Promise<RunLedgerPage> {
  const before = query.cursor === undefined ? undefined : cursorKey(query.cursor);
  const history = await deps.openHistory();
  try {
    const store = history?.store ?? null;
    const reconcile =
      deps.reconcile ??
      (async (historyStore: HistoryStore | null) => {
        await reconcileAll({
          trigger: 'list',
          includeRunningManifests: true,
          history: historyStore,
          ...(deps.logger === undefined ? {} : { logger: deps.logger }),
        });
      });
    const page = await queryRunLedger(
      {
        limit: query.limit,
        activeMode: 'split',
        ...(before === undefined ? {} : { before }),
        ...(query.outcome === undefined ? {} : { outcome: query.outcome }),
        ...(query.mode === undefined ? {} : { mode: query.mode }),
        ...(query.since === undefined ? {} : { since: query.since }),
        ...(query.until === undefined ? {} : { until: query.until }),
        ...(query.text === undefined ? {} : { text: query.text }),
        ...(query.workflow === undefined ? {} : { workflow: query.workflow }),
        ...(query.status === undefined ? {} : { status: query.status }),
      },
      {
        historyStore: store,
        runsDir: deps.runsDir ?? runsRoot(),
        reconcile: () => reconcile(store),
        ...(deps.activeRuns === undefined ? {} : { activeRuns: deps.activeRuns }),
      },
    );
    const build = (items: readonly ListRunItem[], next: LedgerKey | null): RunLedgerPage => ({
      schemaVersion: CLI_READ_SCHEMA_VERSION,
      kind: 'list',
      items: [...items],
      next_cursor: next === null ? null : encodeLedgerCursor(next, page.source),
      source: page.source,
      ...(page.source === 'files' ? { scan_truncated: page.scanTruncated } : {}),
      active: [...page.active],
    });
    let items = [...page.items];
    let result = build(items, page.next);
    // Never over the message budget, never cut mid-item: shorten the page and
    // let the cursor continue from the last row that fits.
    while (items.length > 1 && jsonBytes(result) > MAX_LEDGER_PAGE_BYTES) {
      items = items.slice(0, Math.max(1, Math.floor(items.length * 0.8)));
      const last = items.at(-1)!;
      result = build(items, { startedAt: last.startedAt, runId: last.runId });
    }
    return result;
  } finally {
    history?.close();
  }
}

/** Registers `read.list`. */
export function registerLedgerRead(methods: RpcMethodRegistry, deps: LedgerReadDeps): void {
  methods.register('read.list', {
    params: ReadListParams,
    result: ReadListResult,
    handler: async (params) =>
      params.target === 'workflows' ? deps.listWorkflows() : readLedgerPage(params, deps),
  });
}
