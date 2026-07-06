/**
 * `ScheduleStore` — the registry of recurring, unattended workflow runs
 * (FEAT-021 Scheduling & Saved-Workflow Runner).
 *
 * Backs `yantra schedule` / `yantra schedules` / `yantra unschedule` and is the
 * table the daemon's fire-loop reads from. Unlike `history`, a schedule is
 * **not** reconstructable from the run tree — it is authored state — so, within
 * the otherwise cache-only index, the `schedules` table is the source of truth
 * for what recurs. (Losing `index.db` therefore loses schedules; that is
 * documented and consistent with the daemon being an opt-in Phase-2 surface.)
 *
 * The never-auto-confirm rule (plan §6) is enforced here in depth: `on_confirm`
 * is CHECK-locked to `'pause-and-notify'` in the v2 migration, and this store
 * only ever writes that value. Registration-time credential-shape rejection for
 * params lives in the CLI (reusing the workflow lint rule); this store persists
 * already-validated rows.
 *
 * The store is a repository-like abstraction (mockable in tests) — the same
 * pattern as `HistoryStore`/`PreferenceStore`/`WorkflowStore`. All fallible
 * operations return `Result<T, IndexDbError>`.
 */

import { err, ok, generateUlid, type Result } from '@yantra/protocol';

import type { Logger } from '../browser/types.js';

import type { DatabaseSync } from './sqlite.js';
import { IndexDbError } from './types.js';

/** Where a fire's notification is delivered. Mirrors the SQLite CHECK. */
export type NotifyTarget = 'desktop' | 'file' | 'none';

/**
 * The confirmation policy for an unattended fire. The type is a single-member
 * union on purpose: an unattended run can *only* pause-and-notify on a
 * `requires_confirmation` step — it never self-authorizes (plan §6). Keeping it
 * a type (not a bare string) makes the invariant visible at every call site.
 */
export type OnConfirmPolicy = 'pause-and-notify';

/**
 * Terminal status of the most recent fire, cached on the schedule row for
 * `yantra schedules` display. `pending-confirmation` means the last fire parked
 * on a flagged step and is awaiting `yantra confirm`; `missed` means a fire was
 * due while the daemon was down and was skipped (feature spec §2 missed-fire
 * policy).
 */
export type LastFireStatus = 'succeeded' | 'failed' | 'handoff' | 'pending-confirmation' | 'missed';

/** One registered recurring run, as stored in and read from `schedules`. */
export interface Schedule {
  /** ULID primary key. */
  readonly id: string;
  /** Workflow to run — must resolve in the `WorkflowStore` at registration. */
  readonly workflowName: string;
  /** Cron expression (croner-validated at registration). */
  readonly cronExpr: string;
  /** Workflow params (no secrets — SecretRefs resolve from keychain at fire time). */
  readonly params: Readonly<Record<string, string>>;
  /** Where a fire's notification is delivered. */
  readonly notifyTarget: NotifyTarget;
  /** Confirmation policy — always `'pause-and-notify'`. */
  readonly onConfirm: OnConfirmPolicy;
  /** Whether the daemon fires this schedule. */
  readonly enabled: boolean;
  /** ISO-8601 registration timestamp. */
  readonly createdAt: string;
  /** ISO-8601 timestamp of the last fire, or null when never fired. */
  readonly lastFireAt: string | null;
  /** Advisory cache of the next fire (croner recomputes authoritative), or null. */
  readonly nextFireAt: string | null;
  /** Run id produced by the last fire, or null. */
  readonly lastRunId: string | null;
  /** Terminal status of the last fire, or null when never fired. */
  readonly lastStatus: LastFireStatus | null;
}

/** Fields the caller supplies when registering a new schedule. */
export interface RegisterScheduleInput {
  readonly workflowName: string;
  readonly cronExpr: string;
  readonly params?: Readonly<Record<string, string>>;
  readonly notifyTarget?: NotifyTarget;
  /** Advisory next-fire cache to seed the row (the daemon recomputes). */
  readonly nextFireAt?: string | null;
}

/** Patch applied by {@link ScheduleStore.markFire} after a fire completes. */
export interface MarkFireInput {
  readonly lastFireAt: string;
  readonly lastRunId: string | null;
  readonly lastStatus: LastFireStatus;
  /** Recomputed advisory next fire. */
  readonly nextFireAt: string | null;
}

/**
 * Repository interface over the `schedules` table. Fallible operations return
 * `Result` — a daemon that hits a store error skips the cycle and stays alive
 * (feature spec §6: the daemon must be boring and durable).
 */
export interface ScheduleStore {
  /** Registers a new schedule; the `id`, `createdAt`, and defaults are filled here. */
  register(input: RegisterScheduleInput): Promise<Result<Schedule, IndexDbError>>;
  /** Lists all schedules, most-recently-created first. */
  list(): Promise<Result<readonly Schedule[], IndexDbError>>;
  /** Reads one schedule by id, or `ok(null)` when absent. */
  get(id: string): Promise<Result<Schedule | null, IndexDbError>>;
  /** Lists only enabled schedules (the daemon's fire-loop query). */
  listEnabled(): Promise<Result<readonly Schedule[], IndexDbError>>;
  /** Removes a schedule by id; `ok(false)` when no such row existed. */
  remove(id: string): Promise<Result<boolean, IndexDbError>>;
  /** Enables or disables a schedule; `ok(false)` when no such row existed. */
  setEnabled(id: string, enabled: boolean): Promise<Result<boolean, IndexDbError>>;
  /** Records the outcome of a fire on the schedule row. */
  markFire(id: string, patch: MarkFireInput): Promise<Result<void, IndexDbError>>;
}

/** Constructor dependencies for {@link SqliteScheduleStore}. */
export interface SqliteScheduleStoreDeps {
  /** Open, migrated index handle (schema ≥ v2). */
  readonly db: DatabaseSync;
  /** Optional logger — writes at debug. */
  readonly logger?: Logger;
  /** Injectable clock for deterministic tests; defaults to `Date`. */
  readonly clock?: { now(): Date };
  /** Injectable id generator for deterministic tests; defaults to `generateUlid`. */
  readonly idGen?: () => string;
}

const SELECT_COLUMNS = `
  id, workflow_name, cron_expr, params_json, notify_target, on_confirm,
  enabled, created_at, last_fire_at, next_fire_at, last_run_id, last_status
`;

/** SQLite-backed {@link ScheduleStore}. */
export class SqliteScheduleStore implements ScheduleStore {
  private readonly db: DatabaseSync;
  private readonly logger: Logger | null;
  private readonly clock: { now(): Date };
  private readonly idGen: () => string;

  public constructor(deps: SqliteScheduleStoreDeps) {
    this.db = deps.db;
    this.logger = deps.logger ?? null;
    this.clock = deps.clock ?? { now: () => new Date() };
    this.idGen = deps.idGen ?? generateUlid;
  }

  public register(input: RegisterScheduleInput): Promise<Result<Schedule, IndexDbError>> {
    const schedule: Schedule = {
      id: this.idGen(),
      workflowName: input.workflowName,
      cronExpr: input.cronExpr,
      params: input.params ?? {},
      notifyTarget: input.notifyTarget ?? 'desktop',
      onConfirm: 'pause-and-notify',
      enabled: true,
      createdAt: this.clock.now().toISOString(),
      lastFireAt: null,
      nextFireAt: input.nextFireAt ?? null,
      lastRunId: null,
      lastStatus: null,
    };

    try {
      this.db
        .prepare(
          `INSERT INTO schedules
             (id, workflow_name, cron_expr, params_json, notify_target, on_confirm,
              enabled, created_at, last_fire_at, next_fire_at, last_run_id, last_status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          schedule.id,
          schedule.workflowName,
          schedule.cronExpr,
          JSON.stringify(schedule.params),
          schedule.notifyTarget,
          schedule.onConfirm,
          schedule.enabled ? 1 : 0,
          schedule.createdAt,
          schedule.lastFireAt,
          schedule.nextFireAt,
          schedule.lastRunId,
          schedule.lastStatus,
        );
      this.logger?.debug?.(
        { id: schedule.id, workflowName: schedule.workflowName },
        'schedule registered',
      );
      return Promise.resolve(ok(schedule));
    } catch (error) {
      return Promise.resolve(
        err(
          new IndexDbError('failed to register schedule', {
            op: 'schedule.register',
            cause: error,
          }),
        ),
      );
    }
  }

  public list(): Promise<Result<readonly Schedule[], IndexDbError>> {
    try {
      const rows = this.db
        .prepare(`SELECT ${SELECT_COLUMNS} FROM schedules ORDER BY created_at DESC`)
        .all() as unknown as ScheduleRow[];
      return Promise.resolve(ok(rows.map(rowToSchedule)));
    } catch (error) {
      return Promise.resolve(
        err(new IndexDbError('failed to list schedules', { op: 'schedule.list', cause: error })),
      );
    }
  }

  public get(id: string): Promise<Result<Schedule | null, IndexDbError>> {
    try {
      const row = this.db
        .prepare(`SELECT ${SELECT_COLUMNS} FROM schedules WHERE id = ?`)
        .get(id) as unknown as ScheduleRow | undefined;
      return Promise.resolve(ok(row === undefined ? null : rowToSchedule(row)));
    } catch (error) {
      return Promise.resolve(
        err(new IndexDbError('failed to read schedule', { op: 'schedule.get', cause: error })),
      );
    }
  }

  public listEnabled(): Promise<Result<readonly Schedule[], IndexDbError>> {
    try {
      const rows = this.db
        .prepare(
          `SELECT ${SELECT_COLUMNS} FROM schedules WHERE enabled = 1 ORDER BY created_at DESC`,
        )
        .all() as unknown as ScheduleRow[];
      return Promise.resolve(ok(rows.map(rowToSchedule)));
    } catch (error) {
      return Promise.resolve(
        err(
          new IndexDbError('failed to list enabled schedules', {
            op: 'schedule.listEnabled',
            cause: error,
          }),
        ),
      );
    }
  }

  public remove(id: string): Promise<Result<boolean, IndexDbError>> {
    try {
      const info = this.db.prepare('DELETE FROM schedules WHERE id = ?').run(id);
      return Promise.resolve(ok(Number(info.changes) > 0));
    } catch (error) {
      return Promise.resolve(
        err(new IndexDbError('failed to remove schedule', { op: 'schedule.remove', cause: error })),
      );
    }
  }

  public setEnabled(id: string, enabled: boolean): Promise<Result<boolean, IndexDbError>> {
    try {
      const info = this.db
        .prepare('UPDATE schedules SET enabled = ? WHERE id = ?')
        .run(enabled ? 1 : 0, id);
      return Promise.resolve(ok(Number(info.changes) > 0));
    } catch (error) {
      return Promise.resolve(
        err(
          new IndexDbError('failed to toggle schedule', {
            op: 'schedule.setEnabled',
            cause: error,
          }),
        ),
      );
    }
  }

  public markFire(id: string, patch: MarkFireInput): Promise<Result<void, IndexDbError>> {
    try {
      this.db
        .prepare(
          `UPDATE schedules
             SET last_fire_at = ?, last_run_id = ?, last_status = ?, next_fire_at = ?
           WHERE id = ?`,
        )
        .run(patch.lastFireAt, patch.lastRunId, patch.lastStatus, patch.nextFireAt, id);
      return Promise.resolve(ok(undefined));
    } catch (error) {
      return Promise.resolve(
        err(
          new IndexDbError('failed to mark schedule fire', {
            op: 'schedule.markFire',
            cause: error,
          }),
        ),
      );
    }
  }
}

/** Raw `schedules` row shape as returned by node:sqlite. */
interface ScheduleRow {
  readonly id: string;
  readonly workflow_name: string;
  readonly cron_expr: string;
  readonly params_json: string;
  readonly notify_target: NotifyTarget;
  readonly on_confirm: OnConfirmPolicy;
  readonly enabled: number;
  readonly created_at: string;
  readonly last_fire_at: string | null;
  readonly next_fire_at: string | null;
  readonly last_run_id: string | null;
  readonly last_status: LastFireStatus | null;
}

function rowToSchedule(row: ScheduleRow): Schedule {
  return {
    id: row.id,
    workflowName: row.workflow_name,
    cronExpr: row.cron_expr,
    params: parseParams(row.params_json),
    notifyTarget: row.notify_target,
    onConfirm: row.on_confirm,
    enabled: Number(row.enabled) !== 0,
    createdAt: row.created_at,
    lastFireAt: row.last_fire_at,
    nextFireAt: row.next_fire_at,
    lastRunId: row.last_run_id,
    lastStatus: row.last_status,
  };
}

/** Defensively parse the stored params JSON into a string map. */
function parseParams(json: string): Record<string, string> {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string') {
        out[key] = value;
      }
    }
    return out;
  } catch {
    return {};
  }
}
