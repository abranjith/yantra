/**
 * `HistoryStore` — the indexed record of every task Yantra runs.
 *
 * Backs instant `yantra list` and `yantra usage`, and is the raw material a
 * future personalization signal is *derived* from — but **`history` rows never
 * leave this table for an LLM** (feature spec §2; enforced structurally by
 * TASK-004's input typing and TASK-005's import-graph guard).
 *
 * The table is a cache: {@link SqliteHistoryStore.rebuildFromRuns} reconstructs
 * it entirely from each `runs/<id>/manifest.json` (+ brief metadata), so a deleted or
 * corrupt `index.db` is a recoverable warning, never data loss (plan §7).
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { err, ok, type Result } from '@yantra/protocol';

import { runsRoot } from '../browser/paths.js';
import type { Logger } from '../browser/types.js';

import type { DatabaseSync } from './sqlite.js';
import { IndexDbError, type HistoryStatus, type TaskType } from './types.js';

/** One recorded task, as stored in and read from the `history` table. */
export interface HistoryEntry {
  /** Join key to the run directory (`runs/<run_id>/`). Unique. */
  readonly runId: string;
  /** The task verb. */
  readonly taskType: TaskType;
  /** The query/goal/workflow name as typed. Never sent to an LLM. */
  readonly intentText: string;
  /** Linked `brief.json` id, or null (workflow runs, or brief unavailable). */
  readonly briefId: string | null;
  /** Terminal outcome. */
  readonly status: HistoryStatus;
  /** ISO-8601 start timestamp. */
  readonly startedAt: string;
  /** ISO-8601 finish timestamp, or null when unfinished/unknown. */
  readonly finishedAt: string | null;
  /** Wall-clock duration in ms, or null. */
  readonly durationMs: number | null;
  /** Task cost in USD, or null when not metered. */
  readonly costUsd: number | null;
  /** Search or LLM provider label for usage rollups, or null. */
  readonly provider: string | null;
}

/** Filter for {@link HistoryStore.list}. */
export interface HistoryListFilter {
  /** Restrict to a single task type. */
  readonly taskType?: TaskType;
  /** Only rows with `started_at >= since` (ISO-8601). */
  readonly since?: string;
  /** Max rows (default 50, most-recent first). */
  readonly limit?: number;
}

/** Filter for {@link HistoryStore.usageRollup}. */
export interface UsageRollupFilter {
  /** Only rows with `started_at >= since` (ISO-8601). */
  readonly since?: string;
  /** Restrict to a single task type. */
  readonly taskType?: TaskType;
}

/** One (day, provider) usage bucket. */
export interface UsageRollupRow {
  /** UTC calendar day (`YYYY-MM-DD`) derived from `started_at`. */
  readonly day: string;
  /** Provider label, or null for tasks without one. */
  readonly provider: string | null;
  /** Number of tasks in this bucket. */
  readonly taskCount: number;
  /** Summed `cost_usd` across the bucket (0 when none metered). */
  readonly totalCostUsd: number;
}

/**
 * Repository interface over the `history` table. Fallible operations return
 * `Result` — the caller (CLI) degrades to a file scan rather than failing a
 * task when the index is unavailable.
 */
export interface HistoryStore {
  /** Inserts (or upserts on duplicate `run_id`) one task record. */
  record(entry: HistoryEntry): Promise<Result<void, IndexDbError>>;
  /**
   * Reads `runs/<runId>/manifest.json` (+ brief.json) and records the derived
   * entry — the "record on task completion" path shared by `ask`/`run`. Reading
   * from the canonical run dir keeps the index a faithful cache of the files.
   * Resolves to `ok(false)` when the manifest is missing/unrecognized.
   */
  recordFromRunDir(runId: string): Promise<Result<boolean, IndexDbError>>;
  /** Lists tasks most-recent first, optionally filtered by type/since. */
  list(filter?: HistoryListFilter): Promise<Result<readonly HistoryEntry[], IndexDbError>>;
  /** Rolls up task count + cost grouped by (day, provider). */
  usageRollup(filter?: UsageRollupFilter): Promise<Result<readonly UsageRollupRow[], IndexDbError>>;
  /** Reconstructs the whole table from the run tree. Returns rows written. */
  rebuildFromRuns(): Promise<Result<{ rowCount: number }, IndexDbError>>;
}

/** Constructor dependencies for {@link SqliteHistoryStore}. */
export interface SqliteHistoryStoreDeps {
  /** Open, migrated index handle. */
  readonly db: DatabaseSync;
  /** Runs directory to scan on rebuild; defaults to {@link runsRoot}. */
  readonly runsDir?: string;
  /** Optional logger — writes at debug, rebuild counts at info. */
  readonly logger?: Logger;
}

const DEFAULT_LIST_LIMIT = 50;

const UPSERT_SQL = `
  INSERT INTO history
    (run_id, task_type, intent_text, brief_id, status,
     started_at, finished_at, duration_ms, cost_usd, provider)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(run_id) DO UPDATE SET
    task_type   = excluded.task_type,
    intent_text = excluded.intent_text,
    brief_id    = excluded.brief_id,
    status      = excluded.status,
    started_at  = excluded.started_at,
    finished_at = excluded.finished_at,
    duration_ms = excluded.duration_ms,
    cost_usd    = excluded.cost_usd,
    provider    = excluded.provider
`;

/** SQLite-backed {@link HistoryStore}. */
export class SqliteHistoryStore implements HistoryStore {
  private readonly db: DatabaseSync;
  private readonly runsDir: string;
  private readonly logger: Logger | null;

  public constructor(deps: SqliteHistoryStoreDeps) {
    this.db = deps.db;
    this.runsDir = deps.runsDir ?? runsRoot();
    this.logger = deps.logger ?? null;
  }

  public record(entry: HistoryEntry): Promise<Result<void, IndexDbError>> {
    try {
      this.insert(entry);
      this.logger?.debug?.({ runId: entry.runId, taskType: entry.taskType }, 'history recorded');
      return Promise.resolve(ok(undefined));
    } catch (error) {
      return Promise.resolve(
        err(
          new IndexDbError('failed to record history entry', {
            op: 'history.record',
            cause: error,
          }),
        ),
      );
    }
  }

  public async recordFromRunDir(runId: string): Promise<Result<boolean, IndexDbError>> {
    let entry: HistoryEntry | null;
    try {
      entry = await this.readRunManifest(runId);
    } catch (error) {
      return err(
        new IndexDbError('failed to read run manifest for recording', {
          op: 'history.recordFromRunDir',
          cause: error,
        }),
      );
    }
    if (entry === null) {
      return ok(false);
    }
    const recorded = await this.record(entry);
    return recorded.isOk ? ok(true) : recorded;
  }

  public list(
    filter: HistoryListFilter = {},
  ): Promise<Result<readonly HistoryEntry[], IndexDbError>> {
    try {
      const clauses: string[] = [];
      const params: (string | number)[] = [];
      if (filter.taskType !== undefined) {
        clauses.push('task_type = ?');
        params.push(filter.taskType);
      }
      if (filter.since !== undefined) {
        clauses.push('started_at >= ?');
        params.push(filter.since);
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      const limit = filter.limit ?? DEFAULT_LIST_LIMIT;

      const rows = this.db
        .prepare(
          `SELECT run_id, task_type, intent_text, brief_id, status,
                  started_at, finished_at, duration_ms, cost_usd, provider
             FROM history
             ${where}
             ORDER BY started_at DESC
             LIMIT ?`,
        )
        .all(...params, limit) as unknown as HistoryRow[];

      return Promise.resolve(ok(rows.map(rowToEntry)));
    } catch (error) {
      return Promise.resolve(
        err(new IndexDbError('failed to list history', { op: 'history.list', cause: error })),
      );
    }
  }

  public usageRollup(
    filter: UsageRollupFilter = {},
  ): Promise<Result<readonly UsageRollupRow[], IndexDbError>> {
    try {
      const clauses: string[] = [];
      const params: string[] = [];
      if (filter.taskType !== undefined) {
        clauses.push('task_type = ?');
        params.push(filter.taskType);
      }
      if (filter.since !== undefined) {
        clauses.push('started_at >= ?');
        params.push(filter.since);
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

      const rows = this.db
        .prepare(
          `SELECT substr(started_at, 1, 10) AS day,
                  provider                   AS provider,
                  COUNT(*)                   AS task_count,
                  COALESCE(SUM(cost_usd), 0) AS total_cost_usd
             FROM history
             ${where}
             GROUP BY day, provider
             ORDER BY day DESC, provider ASC`,
        )
        .all(...params) as unknown as UsageRow[];

      return Promise.resolve(
        ok(
          rows.map((row) => ({
            day: row.day,
            provider: row.provider ?? null,
            taskCount: Number(row.task_count),
            totalCostUsd: Number(row.total_cost_usd),
          })),
        ),
      );
    } catch (error) {
      return Promise.resolve(
        err(
          new IndexDbError('failed to roll up usage', { op: 'history.usageRollup', cause: error }),
        ),
      );
    }
  }

  public async rebuildFromRuns(): Promise<Result<{ rowCount: number }, IndexDbError>> {
    let entries: readonly HistoryEntry[];
    try {
      entries = await this.scanRuns();
    } catch (error) {
      return err(
        new IndexDbError('failed to scan run tree for rebuild', {
          op: 'history.rebuildFromRuns',
          cause: error,
        }),
      );
    }

    try {
      this.db.exec('BEGIN');
      this.db.exec('DELETE FROM history');
      for (const entry of entries) {
        this.insert(entry);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // ignore rollback failure
      }
      return err(
        new IndexDbError('failed to write rebuilt history', {
          op: 'history.rebuildFromRuns',
          cause: error,
        }),
      );
    }

    this.logger?.info?.({ rowCount: entries.length }, 'history index rebuilt from run tree');
    return ok({ rowCount: entries.length });
  }

  /** Prepares + runs the upsert for one entry. */
  private insert(entry: HistoryEntry): void {
    this.db
      .prepare(UPSERT_SQL)
      .run(
        entry.runId,
        entry.taskType,
        entry.intentText,
        entry.briefId,
        entry.status,
        entry.startedAt,
        entry.finishedAt,
        entry.durationMs,
        entry.costUsd,
        entry.provider,
      );
  }

  /** Reads every run dir's manifest.json into normalized history entries. */
  private async scanRuns(): Promise<readonly HistoryEntry[]> {
    let dirents: string[];
    try {
      dirents = await readdir(this.runsDir);
    } catch {
      // Absent runs dir → nothing to rebuild.
      return [];
    }

    const results = await Promise.all(
      dirents.map((dir) => this.readRunManifest(dir).catch(() => null)),
    );
    return results.filter((entry): entry is HistoryEntry => entry !== null);
  }

  /** Parses one run dir's manifest (+ brief.json) into a HistoryEntry, or null. */
  private async readRunManifest(dir: string): Promise<HistoryEntry | null> {
    const runDir = join(this.runsDir, dir);
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(await readFile(join(runDir, 'manifest.json'), 'utf8')) as Record<
        string,
        unknown
      >;
    } catch {
      return null;
    }

    const briefMeta = await this.readBriefMeta(runDir);
    return deriveHistoryEntry(dir, raw, briefMeta);
  }

  /** Best-effort read of brief.json for `brief_id` + cost. */
  private async readBriefMeta(runDir: string): Promise<BriefMeta | null> {
    try {
      const brief = JSON.parse(await readFile(join(runDir, 'brief.json'), 'utf8')) as {
        brief_id?: unknown;
        metadata?: { usage?: { cost_usd?: unknown } | null };
      };
      const briefId = typeof brief.brief_id === 'string' ? brief.brief_id : null;
      const costUsd =
        typeof brief.metadata?.usage?.cost_usd === 'number' ? brief.metadata.usage.cost_usd : null;
      return { briefId, costUsd };
    } catch {
      return null;
    }
  }
}

interface BriefMeta {
  readonly briefId: string | null;
  readonly costUsd: number | null;
}

/** Raw `history` row shape as returned by node:sqlite. */
interface HistoryRow {
  readonly run_id: string;
  readonly task_type: TaskType;
  readonly intent_text: string;
  readonly brief_id: string | null;
  readonly status: HistoryStatus;
  readonly started_at: string;
  readonly finished_at: string | null;
  readonly duration_ms: number | null;
  readonly cost_usd: number | null;
  readonly provider: string | null;
}

interface UsageRow {
  readonly day: string;
  readonly provider: string | null;
  readonly task_count: number;
  readonly total_cost_usd: number;
}

function rowToEntry(row: HistoryRow): HistoryEntry {
  return {
    runId: row.run_id,
    taskType: row.task_type,
    intentText: row.intent_text,
    briefId: row.brief_id,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
    costUsd: row.cost_usd === null ? null : Number(row.cost_usd),
    provider: row.provider,
  };
}

const ASK_TASK_TYPES = new Set<TaskType>(['ask', 'research', 'do']);

/**
 * Normalizes a run manifest (either the ask/research pipeline shape or the
 * workflow `RunManifest` shape) into a {@link HistoryEntry}. Returns null for
 * non-terminal or unrecognized manifests so rebuild only stores real history.
 */
export function deriveHistoryEntry(
  dirName: string,
  raw: Record<string, unknown>,
  briefMeta: BriefMeta | null,
): HistoryEntry | null {
  // --- Ask/research/do pipeline manifest: has `type` + `query`.
  const type = raw.type;
  if (typeof type === 'string' && ASK_TASK_TYPES.has(type as TaskType)) {
    const startedAt = asString(raw.started_at);
    if (startedAt === null) {
      return null;
    }
    const finishedAt = asString(raw.finished_at);
    return {
      runId: dirName,
      taskType: type as TaskType,
      intentText: asString(raw.query) ?? '',
      briefId: briefMeta?.briefId ?? null,
      status: mapAskStatus(asString(raw.status)),
      startedAt,
      finishedAt,
      durationMs: durationBetween(startedAt, finishedAt),
      costUsd: briefMeta?.costUsd ?? null,
      provider: asString(raw.search_provider),
    };
  }

  // --- Workflow RunManifest: has `workflowName` + `runId`.
  const workflowName = asString(raw.workflowName);
  if (workflowName !== null) {
    const startedAt = asString(raw.startedAt);
    if (startedAt === null) {
      return null;
    }
    const status = mapRunStatus(asString(raw.status));
    if (status === null) {
      return null; // running/queued/paused-without-mapping → not terminal history
    }
    const finishedAt = asString(raw.endedAt);
    return {
      runId: asString(raw.runId) ?? dirName,
      taskType: 'run',
      intentText: workflowName,
      briefId: briefMeta?.briefId ?? null,
      status,
      startedAt,
      finishedAt,
      durationMs: asNumber(raw.durationMs) ?? durationBetween(startedAt, finishedAt),
      costUsd: briefMeta?.costUsd ?? null,
      provider: null,
    };
  }

  return null;
}

/** Maps ask-pipeline status (`ok`/`partial`/`failed`) to a history status. */
function mapAskStatus(status: string | null): HistoryStatus {
  return status === 'failed' ? 'failed' : 'succeeded';
}

/** Maps workflow run status to a terminal history status, or null if not terminal. */
function mapRunStatus(status: string | null): HistoryStatus | null {
  switch (status) {
    case 'completed':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'aborted':
      return 'aborted';
    case 'paused':
      return 'handoff';
    default:
      return null;
  }
}

function durationBetween(startedAt: string, finishedAt: string | null): number | null {
  if (finishedAt === null) {
    return null;
  }
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
