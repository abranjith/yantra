/**
 * The Ledger query (FEAT-066 TASK-002): the one function behind `yantra list`
 * and the app's `read.list`.
 *
 * Runs come from two sources, merged exactly as `yantra list` always has:
 * index rows and file rows de-duplicated by run id, the index winning, sorted
 * `startedAt DESC, runId DESC`.
 *
 * - **Index:** {@link HistoryStore.page} with keyset paging and the filters.
 * - **Files:** run directory names, newest first. A `formatRunId` name starts
 *   with the second the run began, so the scan stops as soon as no older
 *   directory can enter the page; names in any other form are always read.
 *   Manifests are read only for candidates, in chunks, and a scan reads at
 *   most {@link FILE_SCAN_CAP} directories per call (`scanTruncated`). A
 *   corrupt manifest skips that row only. A file row whose run id the index
 *   knows is dropped whatever the filters say, because the index row wins.
 *
 * Runs that have not ended (`running` or `queued` manifests) stay in `items`
 * for the CLI (`activeMode: 'inline'`). The app (`'split'`) gets them
 * separately in `active` on the first page only, never paginated, together
 * with the host's own view of live runs.
 */

import { readFile as fsReadFile, readdir as fsReaddir, stat as fsStat } from 'node:fs/promises';
import { join } from 'node:path';

import {
  LedgerCursor,
  TaskOutcome,
  isRunId,
  type LedgerActiveRun,
  type LedgerDisplayedState,
  type LedgerMode,
  type LedgerOutcomeFilter,
  type ListRunItem,
} from '@yantra/protocol';

import type { HistoryEntry, HistoryStore } from '../index-db/history-store.js';
import { readExecutionState } from '../run-ownership/sweep.js';

import { LedgerCursorError } from './errors.js';

/** The most run directories one call reads (the file fallback's cap). */
export const FILE_SCAN_CAP = 2_000;
/** The newest run directories scanned for active runs on the first page. */
export const ACTIVE_SCAN_CAP = 200;
/**
 * How long after its directory name's second a manifest's `startedAt` may
 * fall. The scan reads that much further back, so a slow start never hides a
 * run from its page.
 */
export const START_SLACK_MS = 5 * 60_000;
/** How far a manifest's `startedAt` may precede its directory name's second. */
export const EARLY_SLACK_MS = 5_000;

const MANIFEST_CHUNK = 50;
const LEDGER_MODES: ReadonlySet<string> = new Set(['ask', 'research', 'do']);
const TASK_OUTCOMES: ReadonlySet<string> = new Set(TaskOutcome.options);
const NON_TERMINAL: ReadonlySet<string> = new Set(['running', 'queued']);
const NAME_TIME = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-/u;

/** A position in `startedAt DESC, runId DESC` order. */
export interface LedgerKey {
  readonly startedAt: string;
  readonly runId: string;
}

/** A run the host knows is in progress (FEAT-065 invocations, FEAT-064 leases). */
export interface ActiveRun {
  readonly runId: string;
  readonly displayedState: LedgerDisplayedState;
  /** Used only when the run has no readable manifest yet. */
  readonly workflowName?: string;
  readonly startedAt?: string;
}

/** One Ledger query. */
export interface LedgerQuery {
  readonly limit: number;
  readonly before?: LedgerKey;
  readonly outcome?: readonly LedgerOutcomeFilter[];
  readonly mode?: readonly LedgerMode[];
  readonly since?: string;
  readonly until?: string;
  readonly text?: string;
  readonly workflow?: string;
  readonly status?: string;
  /** `inline`: unfinished runs stay in `items` (CLI); `split`: they go to `active` (app). */
  readonly activeMode: 'inline' | 'split';
}

/** One Ledger page. */
export interface LedgerResult {
  readonly items: readonly ListRunItem[];
  readonly next: LedgerKey | null;
  readonly source: 'index' | 'files';
  readonly scanTruncated: boolean;
  readonly active: readonly LedgerActiveRun[];
}

/** The filesystem calls the ledger makes; injected in tests. */
export interface LedgerFs {
  readdir(path: string): Promise<string[]>;
  readFile(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
}

/** Node's `fs/promises`. */
export const NODE_LEDGER_FS: LedgerFs = {
  readdir: (path) => fsReaddir(path),
  readFile: (path) => fsReadFile(path, 'utf8'),
  exists: (path) =>
    fsStat(path).then(
      (info) => info.isFile(),
      () => false,
    ),
};

export interface RunLedgerDeps {
  /** The open history index, or null when it is unavailable or rebuilding. */
  readonly historyStore: HistoryStore | null;
  /** The runs directory, from `runsRoot()`. */
  readonly runsDir: string;
  /** Runs the host knows are in progress (`split` mode, first page). */
  readonly activeRuns?: () => Promise<readonly ActiveRun[]>;
  /** FEAT-064 reconciliation, run first exactly as `yantra list` does; failures never fail it. */
  readonly reconcile?: () => Promise<void>;
  readonly fs?: LedgerFs;
  readonly fileScanCap?: number;
  readonly activeScanCap?: number;
}

/** `a` sorts before `b` in `startedAt DESC, runId DESC` order (binary, as SQLite compares). */
export function compareNewestFirst(a: LedgerKey, b: LedgerKey): number {
  if (a.startedAt !== b.startedAt) return a.startedAt > b.startedAt ? -1 : 1;
  if (a.runId !== b.runId) return a.runId > b.runId ? -1 : 1;
  return 0;
}

/** Encodes a page position as an opaque, versioned cursor. */
export function encodeLedgerCursor(key: LedgerKey, source: 'index' | 'files'): string {
  const cursor: LedgerCursor = {
    v: 1,
    started_at: key.startedAt,
    run_id: key.runId,
    source,
  };
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/**
 * Decodes a cursor from {@link encodeLedgerCursor}.
 *
 * @throws {LedgerCursorError} for anything else; it never falls back to page one.
 */
export function decodeLedgerCursor(cursor: string): LedgerKey & {
  readonly source: 'index' | 'files';
} {
  if (!/^[A-Za-z0-9_-]+$/u.test(cursor)) throw new LedgerCursorError('encoding');
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new LedgerCursorError('encoding');
  }
  const parsed = LedgerCursor.safeParse(raw);
  if (!parsed.success) throw new LedgerCursorError('schema');
  return {
    startedAt: parsed.data.started_at,
    runId: parsed.data.run_id,
    source: parsed.data.source,
  };
}

/** Epoch ms of the second a `formatRunId` name encodes, or null for other names. */
export function runIdStartMs(name: string): number | null {
  const match = NAME_TIME.exec(name);
  if (match === null) return null;
  const [, y, mo, d, h, mi, s] = match;
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  return Number.isFinite(ms) ? ms : null;
}

/** One candidate row and how to enrich it. */
interface Row {
  readonly key: LedgerKey;
  readonly item: ListRunItem;
  /** Run directory, for the execution state and document checks. */
  readonly dir: string;
  readonly briefId: string | null;
  readonly terminal: boolean;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function modeOf(manifest: Readonly<Record<string, unknown>>, workflowName: string): LedgerMode {
  return manifest.runKind === 'agentic' && LEDGER_MODES.has(workflowName)
    ? (workflowName as LedgerMode)
    : 'run';
}

/** The `list` item for one listable workflow-shaped manifest, or null. */
function fileRow(dir: string, manifest: Readonly<Record<string, unknown>>): Row | null {
  const runId = asString(manifest.runId);
  const workflowName = asString(manifest.workflowName);
  const startedAt = asString(manifest.startedAt);
  if (runId === null || workflowName === null || startedAt === null) return null;
  const status = asString(manifest.status) ?? 'unknown';
  const outcome = asString(manifest.taskOutcome);
  const duration = manifest.durationMs;
  const item: ListRunItem = {
    kind: 'run',
    runId,
    workflowName,
    status,
    startedAt,
    durationMs: typeof duration === 'number' && Number.isFinite(duration) ? duration : null,
    ...(outcome !== null && TASK_OUTCOMES.has(outcome)
      ? { taskOutcome: outcome as TaskOutcome }
      : {}),
    taskType: modeOf(manifest, workflowName),
  };
  return {
    key: { startedAt, runId },
    item,
    dir,
    briefId: null,
    terminal: !NON_TERMINAL.has(status),
  };
}

function indexRow(runsDir: string, entry: HistoryEntry): Row {
  const item: ListRunItem = {
    kind: 'run',
    runId: entry.runId,
    workflowName: entry.intentText,
    status: entry.status,
    startedAt: entry.startedAt,
    durationMs: entry.durationMs,
    ...(entry.taskOutcome === null ? {} : { taskOutcome: entry.taskOutcome }),
    taskType: entry.taskType,
    costUsd: entry.costUsd,
  };
  return {
    key: { startedAt: entry.startedAt, runId: entry.runId },
    item,
    dir: join(runsDir, entry.runId),
    briefId: entry.briefId,
    terminal: true,
  };
}

/** True when a file row passes every filter except the keyset. */
function matchesFilters(item: ListRunItem, query: LedgerQuery): boolean {
  if (query.outcome !== undefined && query.outcome.length > 0) {
    const word = item.taskOutcome ?? 'unknown';
    if (!query.outcome.includes(word)) return false;
  }
  if (query.mode !== undefined && query.mode.length > 0) {
    if (item.taskType === undefined || !query.mode.includes(item.taskType)) return false;
  }
  if (query.since !== undefined && item.startedAt < query.since) return false;
  if (query.until !== undefined && item.startedAt >= query.until) return false;
  if (query.text !== undefined) {
    const needle = query.text.toLowerCase();
    if (
      !item.workflowName.toLowerCase().includes(needle) &&
      !item.runId.toLowerCase().includes(needle)
    ) {
      return false;
    }
  }
  if (query.workflow !== undefined && item.workflowName !== query.workflow) return false;
  if (query.status !== undefined && item.status !== query.status) return false;
  return true;
}

function afterKey(key: LedgerKey, before: LedgerKey | undefined): boolean {
  return before === undefined || compareNewestFirst(before, key) < 0;
}

/** Splits directory names into `formatRunId` names (newest first) and the rest. */
function orderNames(names: readonly string[]): {
  timed: { name: string; ms: number }[];
  untimed: string[];
} {
  const timed: { name: string; ms: number }[] = [];
  const untimed: string[] = [];
  for (const name of names) {
    const ms = runIdStartMs(name);
    if (ms === null) untimed.push(name);
    else timed.push({ name, ms });
  }
  timed.sort((a, b) => (a.name > b.name ? -1 : a.name < b.name ? 1 : 0));
  return { timed, untimed };
}

async function readManifest(
  fs: LedgerFs,
  dir: string,
): Promise<Readonly<Record<string, unknown>> | null> {
  try {
    const raw = JSON.parse(await fs.readFile(join(dir, 'manifest.json'))) as unknown;
    return raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : null;
  } catch {
    // A missing or corrupt manifest skips this row only.
    return null;
  }
}

interface ScanResult {
  readonly rows: readonly Row[];
  readonly truncated: boolean;
}

/**
 * Reads file rows that pass the keyset and filters, stopping once nothing
 * older can enter the top `wanted` of `floor ∪ found`.
 */
async function scanFiles(
  names: readonly string[],
  query: LedgerQuery,
  deps: RunLedgerDeps,
  floor: readonly Row[],
  wanted: number,
  keep: (row: Row) => boolean,
): Promise<ScanResult> {
  const fs = deps.fs ?? NODE_LEDGER_FS;
  const cap = deps.fileScanCap ?? FILE_SCAN_CAP;
  const { timed, untimed } = orderNames(names);
  const beforeMs = query.before === undefined ? null : Date.parse(query.before.startedAt);
  const sinceMs = query.since === undefined ? null : Date.parse(query.since);
  const found: Row[] = [];
  const seen = new Set<string>();
  let reads = 0;
  let truncated = false;

  const boundary = (): string | null => {
    const top = [...floor, ...found].map((row) => row.key).sort(compareNewestFirst);
    return top.length >= wanted ? top[wanted - 1]!.startedAt : null;
  };

  const readChunk = async (chunk: readonly string[]): Promise<void> => {
    const rows = (
      await Promise.all(
        chunk.map(async (name) => {
          const dir = join(deps.runsDir, name);
          const manifest = await readManifest(fs, dir);
          return manifest === null ? null : fileRow(dir, manifest);
        }),
      )
    ).filter((row): row is Row => row !== null);
    let known: ReadonlySet<string> = new Set();
    if (deps.historyStore !== null && rows.length > 0) {
      const lookup = await deps.historyStore.knownRunIds(rows.map((row) => row.key.runId));
      if (lookup.isOk) known = lookup.value;
    }
    for (const row of rows) {
      if (known.has(row.key.runId) || seen.has(row.key.runId)) continue;
      seen.add(row.key.runId);
      if (!afterKey(row.key, query.before) || !matchesFilters(row.item, query) || !keep(row)) {
        continue;
      }
      found.push(row);
    }
  };

  /** How many of `wanted` names the cap still allows; marks the scan truncated at the cap. */
  const allowance = (wantedReads: number): number => {
    const left = Math.max(0, cap - reads);
    if (left < wantedReads) truncated = true;
    const granted = Math.min(left, wantedReads);
    reads += granted;
    return granted;
  };

  // Names in any other form carry no start time, so every one is a candidate.
  for (let start = 0; start < untimed.length; ) {
    const granted = allowance(Math.min(MANIFEST_CHUNK, untimed.length - start));
    if (granted === 0) return { rows: found, truncated };
    await readChunk(untimed.slice(start, start + granted));
    start += granted;
  }

  let index = 0;
  // Skip directories that began after the cursor: their runs cannot be on this page.
  if (beforeMs !== null && Number.isFinite(beforeMs)) {
    while (index < timed.length && timed[index]!.ms - EARLY_SLACK_MS > beforeMs) index += 1;
  }
  while (index < timed.length) {
    const limitTime = boundary();
    const next = timed[index]!;
    if (limitTime !== null && Date.parse(limitTime) >= next.ms + START_SLACK_MS) break;
    if (sinceMs !== null && Number.isFinite(sinceMs) && next.ms + START_SLACK_MS < sinceMs) {
      break;
    }
    const granted = allowance(Math.min(MANIFEST_CHUNK, timed.length - index));
    if (granted === 0) break;
    await readChunk(timed.slice(index, index + granted).map((entry) => entry.name));
    index += granted;
  }
  return { rows: found, truncated };
}

/** The newest `cap` run directories whose manifests say the run has not ended. */
async function scanActive(
  names: readonly string[],
  deps: RunLedgerDeps,
): Promise<{ manifests: Map<string, Row> }> {
  const fs = deps.fs ?? NODE_LEDGER_FS;
  const { timed, untimed } = orderNames(names);
  const newest = [...timed.map((entry) => entry.name), ...untimed].slice(
    0,
    deps.activeScanCap ?? ACTIVE_SCAN_CAP,
  );
  const manifests = new Map<string, Row>();
  const rows = await Promise.all(
    newest.map(async (name) => {
      const dir = join(deps.runsDir, name);
      const manifest = await readManifest(fs, dir);
      return manifest === null ? null : fileRow(dir, manifest);
    }),
  );
  for (const row of rows) if (row !== null) manifests.set(row.key.runId, row);
  return { manifests };
}

function displayedFromManifest(status: string): LedgerDisplayedState {
  return status === 'queued' ? 'queued' : 'unknown_owner';
}

async function activeRegion(
  names: readonly string[],
  query: LedgerQuery,
  deps: RunLedgerDeps,
): Promise<LedgerActiveRun[]> {
  const fs = deps.fs ?? NODE_LEDGER_FS;
  const [{ manifests }, known] = await Promise.all([
    scanActive(names, deps),
    deps.activeRuns === undefined ? Promise.resolve([]) : deps.activeRuns(),
  ]);
  const active = new Map<string, LedgerActiveRun>();
  for (const run of known) {
    // Only a well-formed run id ever becomes a path.
    if (!isRunId(run.runId)) continue;
    let row = manifests.get(run.runId) ?? null;
    if (row === null) {
      const dir = join(deps.runsDir, run.runId);
      const manifest = await readManifest(fs, dir);
      row = manifest === null ? null : fileRow(dir, manifest);
    }
    if (row?.terminal === true) continue;
    const item: ListRunItem | null =
      row?.item ??
      (run.workflowName !== undefined && run.startedAt !== undefined
        ? {
            kind: 'run',
            runId: run.runId,
            workflowName: run.workflowName,
            status: 'running',
            startedAt: run.startedAt,
            durationMs: null,
          }
        : null);
    if (item !== null) active.set(run.runId, { ...item, displayedState: run.displayedState });
  }
  for (const row of manifests.values()) {
    if (row.terminal || active.has(row.key.runId)) continue;
    // A manifest that says running, with no owner the host can verify, is
    // never shown as running or as dead (memory -> Architecture).
    active.set(row.key.runId, {
      ...row.item,
      displayedState: displayedFromManifest(row.item.status),
    });
  }
  return [...active.values()]
    .filter((run) => matchesFilters(run, query))
    .sort((a, b) => compareNewestFirst(a, b));
}

async function enrich(row: Row, fs: LedgerFs): Promise<ListRunItem> {
  // A corrupt manifest fails only its own detail, never the list.
  const [executionState, hasDocument] = await Promise.all([
    readExecutionState(row.dir).catch(() => undefined),
    row.briefId !== null
      ? Promise.resolve(true)
      : Promise.all([
          fs.exists(join(row.dir, 'brief.json')),
          fs.exists(join(row.dir, 'document.json')),
        ]).then(([brief, document]) => brief || document),
  ]);
  const { taskType, costUsd, ...base } = row.item;
  return {
    ...base,
    ...(executionState === undefined ? {} : { executionState }),
    ...(taskType === undefined ? {} : { taskType }),
    costUsd: costUsd ?? null,
    hasDocument,
  };
}

/**
 * One Ledger page; see the module comment.
 *
 * @param query - `limit` is taken as given; callers clamp it.
 */
export async function queryRunLedger(
  query: LedgerQuery,
  deps: RunLedgerDeps,
): Promise<LedgerResult> {
  if (deps.reconcile !== undefined) await deps.reconcile().catch(() => undefined);
  const fs = deps.fs ?? NODE_LEDGER_FS;
  const wanted = query.limit + 1;

  let indexRows: Row[] = [];
  let source: 'index' | 'files' = 'files';
  let store = deps.historyStore;
  if (store !== null) {
    const page = await store.page({
      limit: wanted,
      ...(query.before === undefined ? {} : { before: query.before }),
      ...(query.outcome === undefined ? {} : { outcome: query.outcome }),
      ...(query.mode === undefined ? {} : { mode: query.mode }),
      ...(query.since === undefined ? {} : { since: query.since }),
      ...(query.until === undefined ? {} : { until: query.until }),
      ...(query.text === undefined ? {} : { text: query.text }),
      ...(query.workflow === undefined ? {} : { workflow: query.workflow }),
      ...(query.status === undefined ? {} : { status: query.status }),
    });
    if (page.isOk) {
      source = 'index';
      indexRows = page.value.entries.map((entry) => indexRow(deps.runsDir, entry));
    } else {
      store = null;
    }
  }

  let names: string[] = [];
  try {
    names = await fs.readdir(deps.runsDir);
  } catch {
    // No runs directory yet: no file rows.
  }

  const split = query.activeMode === 'split';
  const scan = await scanFiles(
    names,
    query,
    { ...deps, historyStore: store },
    indexRows,
    wanted,
    (row) => !split || row.terminal,
  );

  const merged = [...indexRows, ...scan.rows].sort((a, b) => compareNewestFirst(a.key, b.key));
  const pageRows = merged.slice(0, query.limit);
  const items = await Promise.all(pageRows.map((row) => enrich(row, fs)));
  const last = pageRows.at(-1);
  const next = merged.length > query.limit && last !== undefined ? last.key : null;
  const active = split && query.before === undefined ? await activeRegion(names, query, deps) : [];

  return {
    items,
    next,
    source,
    scanTruncated: source === 'files' && scan.truncated,
    active,
  };
}
