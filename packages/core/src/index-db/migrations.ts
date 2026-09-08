/**
 * Forward-only, table-driven schema migrations for the local SQLite index
 * (`~/.yantra/data/index.db`).
 *
 * The index is a **rebuildable cache, not the source of truth** — the run-dir
 * files stay canonical (plan §7). Migrations are therefore free to be simple
 * and forward-only: a corrupt or out-of-date DB is discarded and rebuilt from
 * the run tree rather than laboriously repaired.
 *
 * Versioning uses SQLite's built-in `PRAGMA user_version` as the control
 * counter (atomic, crash-safe) and mirrors it into `meta.db_schema_version`
 * for `sqlite3 index.db` inspection. Each migration is `{ version, up }`;
 * {@link runMigrations} applies every migration whose version is greater than
 * the DB's current `user_version`, in order, each inside a transaction.
 *
 * Scheduling is migration v2 and local domain ranking is migration v3. Append
 * future steps to {@link MIGRATIONS}; never edit a shipped migration.
 */

/** Migration v3 adds local-only domain ranking; future steps remain append-only. */

import type { DatabaseSync } from './sqlite.js';

/** The latest schema version this build knows how to produce. */
export const SCHEMA_VERSION = 3;

/** One forward-only migration step. */
export interface Migration {
  /** Monotonic version this migration brings the schema up to. */
  readonly version: number;
  /** Applies the schema changes. Runs inside a transaction. */
  readonly up: (db: DatabaseSync) => void;
}

/**
 * v1 — the initial index schema: `history`, `preferences`, `rate_limits`, and
 * `meta`, plus the history query indexes. Mirrors feature spec §2.
 */
const migration001: Migration = {
  version: 1,
  up: (db) => {
    db.exec(`
      CREATE TABLE history (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id       TEXT    NOT NULL UNIQUE,
        task_type    TEXT    NOT NULL CHECK (task_type IN ('ask','research','run','do')),
        intent_text  TEXT    NOT NULL,
        brief_id     TEXT,
        status       TEXT    NOT NULL CHECK (status IN ('succeeded','failed','handoff','aborted')),
        started_at   TEXT    NOT NULL,
        finished_at  TEXT,
        duration_ms  INTEGER,
        cost_usd     REAL,
        provider     TEXT
      );

      CREATE INDEX idx_history_started_at ON history(started_at DESC);
      CREATE INDEX idx_history_task_type  ON history(task_type);

      CREATE TABLE preferences (
        key        TEXT PRIMARY KEY,
        value      TEXT    NOT NULL,
        source     TEXT    NOT NULL CHECK (source IN ('user','learned')),
        approved   INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT    NOT NULL
      );

      CREATE TABLE rate_limits (
        host              TEXT PRIMARY KEY,
        tokens            REAL NOT NULL,
        window_started_at TEXT NOT NULL
      );

      CREATE TABLE meta (
        key   TEXT PRIMARY KEY,
        value TEXT
      );
    `);
  },
};

/**
 * v2 — the `schedules` table (FEAT-021 Scheduling & Saved-Workflow Runner).
 *
 * One row per registered recurring workflow run. `on_confirm` is CHECK-locked
 * to the single safe value `'pause-and-notify'` so the never-auto-confirm rule
 * (plan §6) is enforced at the storage layer, not just in flag parsing. The
 * `next_fire_at` cache column is advisory — croner recomputes the authoritative
 * next fire at load time (feature spec §2).
 */
const migration002: Migration = {
  version: 2,
  up: (db) => {
    db.exec(`
      CREATE TABLE schedules (
        id            TEXT    PRIMARY KEY,
        workflow_name TEXT    NOT NULL,
        cron_expr     TEXT    NOT NULL,
        params_json   TEXT    NOT NULL DEFAULT '{}',
        notify_target TEXT    NOT NULL DEFAULT 'desktop'
                              CHECK (notify_target IN ('desktop','file','none')),
        on_confirm    TEXT    NOT NULL DEFAULT 'pause-and-notify'
                              CHECK (on_confirm = 'pause-and-notify'),
        enabled       INTEGER NOT NULL DEFAULT 1,
        created_at    TEXT    NOT NULL,
        last_fire_at  TEXT,
        next_fire_at  TEXT,
        last_run_id   TEXT,
        last_status   TEXT
      );

      CREATE INDEX idx_schedules_enabled_next_fire
        ON schedules(enabled, next_fire_at);
    `);
  },
};

/**
 * v3 — local domain-ranking observations and user-curated domains.
 *
 * Only normalized hostnames and aggregate counters are retained; URLs,
 * queries, and page content never enter this table.
 */
const migration003: Migration = {
  version: 3,
  up: (db) => {
    db.exec(`
      CREATE TABLE domain_ranks (
        domain           TEXT    PRIMARY KEY,
        rank             INTEGER NOT NULL DEFAULT 0
                                 CHECK (rank BETWEEN -100 AND 100),
        positive_signals INTEGER NOT NULL DEFAULT 0,
        negative_signals INTEGER NOT NULL DEFAULT 0,
        origin           TEXT    NOT NULL CHECK (origin IN ('auto','user')),
        first_seen_at    TEXT    NOT NULL,
        last_signal_at   TEXT    NOT NULL
      );

      CREATE INDEX idx_domain_ranks_rank ON domain_ranks(rank DESC);
    `);
  },
};

/** All migrations, ascending by version. Append-only. */
export const MIGRATIONS: readonly Migration[] = [migration001, migration002, migration003];

/**
 * Reads the DB's current schema version from `PRAGMA user_version`.
 *
 * @returns the current version (`0` for a fresh, unmigrated database).
 */
export function currentSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  return typeof row?.user_version === 'number' ? row.user_version : 0;
}

/**
 * Applies every pending migration in order, each in its own transaction, then
 * records the resulting version in both `PRAGMA user_version` and
 * `meta.db_schema_version`. Idempotent: a DB already at {@link SCHEMA_VERSION}
 * is left untouched.
 *
 * @param db - An open database handle.
 * @returns the schema version after migration.
 */
export function runMigrations(db: DatabaseSync): number {
  let version = currentSchemaVersion(db);

  for (const migration of MIGRATIONS) {
    if (migration.version <= version) {
      continue;
    }

    db.exec('BEGIN');
    try {
      migration.up(db);
      // user_version does not accept a bound parameter — it is a pragma, so the
      // integer is inlined. `migration.version` is a trusted in-code constant.
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    version = migration.version;
  }

  // Mirror the version into meta for external inspection (best-effort — the
  // meta table exists from v1 onward).
  if (version >= 1) {
    db.prepare(
      `INSERT INTO meta (key, value) VALUES ('db_schema_version', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(String(version));
  }

  return version;
}
