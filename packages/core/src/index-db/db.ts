/**
 * Local SQLite index — open, migrate, corruption recovery, close.
 *
 * **Cache, not source of truth.** `index.db` accelerates `list`/`usage` and
 * powers personalization signals, but every row it holds is reconstructable
 * from the canonical run-dir files (plan §7). This module therefore treats a
 * corrupt or unreadable database as a *warning*, never data loss: the bad file
 * is renamed aside, a fresh schema is created, and (when a `rebuild` hook is
 * provided) the index is reconstructed from the run tree.
 *
 * Backing engine: Node's built-in `node:sqlite` (`DatabaseSync`) — no native
 * dependency to prebuild across the CI matrix. The DB is opened with
 * `journal_mode=WAL` and `foreign_keys=ON`, and the file is chmod-ed to `0600`
 * on POSIX platforms (doctor warns if it drifts, consistent with the existing
 * data-dir permission checks).
 */

import { chmod, mkdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { dataDir } from '../browser/paths.js';
import type { Logger } from '../browser/types.js';
import { loadConfig } from '../config/load.js';
import { pruneRetention } from '../retention/prune.js';

import { runMigrations } from './migrations.js';
import { DatabaseSync } from './sqlite.js';

/** Sentinel path that opens a transient in-memory database (tests). */
export const IN_MEMORY_PATH = ':memory:';

/**
 * Returns the canonical path to the local SQLite index.
 *
 * @example indexDbPath() // → "/home/user/.yantra/data/index.db"
 */
export function indexDbPath(): string {
  return join(dataDir(), 'index.db');
}

/** Hook that repopulates a freshly-recreated index from the canonical files. */
export type IndexRebuildHook = (db: DatabaseSync) => Promise<void> | void;

/** Options for {@link openIndexDb}. */
export interface OpenIndexDbOptions {
  /** Database file path; defaults to {@link indexDbPath}. `:memory:` for tests. */
  readonly path?: string;
  /** Optional logger — corruption + rebuild events are logged at warn/info. */
  readonly logger?: Logger;
  /**
   * Invoked after a corruption-triggered fresh open, with the new empty (but
   * migrated) handle, to reconstruct the index from the run tree. Absent = a
   * corrupt DB is simply reset to an empty schema (rebuilt lazily later).
   */
  readonly rebuild?: IndexRebuildHook;
}

/** Result of opening the index. */
export interface OpenIndexDbResult {
  /** The open, migrated database handle. */
  readonly db: DatabaseSync;
  /** Resolved on-disk path (or `:memory:`). */
  readonly path: string;
  /** True when the prior file was corrupt and had to be reset/rebuilt. */
  readonly wasCorrupt: boolean;
}

const isMemory = (path: string): boolean => path === IN_MEMORY_PATH;

/** Applies the standing connection pragmas (WAL + FK enforcement). */
function applyPragmas(db: DatabaseSync): void {
  // WAL keeps write-through cheap (used by the rate-limit store's per-update
  // flush); foreign_keys are enforced for any relational integrity we add.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
}

/**
 * Runs `PRAGMA integrity_check` and returns true when the database is healthy.
 * A throwing check (e.g. "file is not a database") counts as corrupt.
 */
function isHealthy(db: DatabaseSync): boolean {
  try {
    const row = db.prepare('PRAGMA integrity_check').get() as
      | { integrity_check?: string }
      | undefined;
    return row?.integrity_check === 'ok';
  } catch {
    return false;
  }
}

/**
 * Opens (creating if needed) and migrates the local SQLite index.
 *
 * On a corruption signal — either the file fails to open as a database or
 * `PRAGMA integrity_check` is not `ok` — the bad file is renamed to
 * `<path>.corrupt.<timestamp>`, a fresh schema is created, the optional
 * `rebuild` hook repopulates it from the run tree, and `wasCorrupt` is set.
 *
 * @param options - Path, logger, and optional rebuild hook.
 * @returns The open handle plus corruption/rebuild status.
 */
export async function openIndexDb(options: OpenIndexDbOptions = {}): Promise<OpenIndexDbResult> {
  const path = options.path ?? indexDbPath();
  const logger = options.logger;
  let retentionConfig: Awaited<ReturnType<typeof loadConfig>> | undefined;

  if (!isMemory(path)) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    retentionConfig = await loadConfig();
    if (retentionConfig.isOk) {
      await pruneRetention({
        config: retentionConfig.value,
        runsPath: join(dataDir(), 'runs'),
        indexPath: path,
      });
    }
  }

  // --- First attempt: open the existing (or new) file and verify health.
  let db: DatabaseSync | null = null;
  let healthy = false;
  try {
    db = new DatabaseSync(path);
    applyPragmas(db);
    healthy = isHealthy(db);
  } catch (error) {
    logger?.warn(
      { path, error: error instanceof Error ? error.message : String(error) },
      'index.db failed to open; treating as corrupt',
    );
    // `healthy` stays false (its initial value) — fall through to the rebuild path.
  }

  if (db !== null && healthy) {
    runMigrations(db);
    await hardenPerms(path, logger);
    return { db, path, wasCorrupt: false };
  }

  // --- Corruption path: discard the bad file and rebuild a fresh index.
  if (db !== null) {
    try {
      db.close();
    } catch {
      // Best-effort — a corrupt handle may already be unusable.
    }
  }

  if (!isMemory(path)) {
    const asidePath = `${path}.corrupt.${Date.now()}`;
    try {
      await rename(path, asidePath);
      logger?.warn({ path, asidePath }, 'index.db was corrupt; moved aside and rebuilding');
      if (retentionConfig?.isOk) {
        await pruneRetention({
          config: retentionConfig.value,
          runsPath: join(dataDir(), 'runs'),
          indexPath: path,
        });
      }
    } catch {
      // No file to move (e.g. the *directory* was the problem) — proceed to a
      // fresh create anyway.
    }
  }

  const fresh = new DatabaseSync(path);
  applyPragmas(fresh);
  runMigrations(fresh);

  if (options.rebuild) {
    await options.rebuild(fresh);
    setMeta(fresh, 'last_rebuilt_at', new Date().toISOString());
    logger?.info({ path }, 'index.db rebuilt from run tree after corruption');
  }

  await hardenPerms(path, logger);
  return { db: fresh, path, wasCorrupt: true };
}

/** Best-effort chmod 0600 on POSIX; a no-op on Windows / in-memory. */
async function hardenPerms(path: string, logger?: Logger): Promise<void> {
  if (isMemory(path) || process.platform === 'win32') {
    return;
  }
  try {
    await chmod(path, 0o600);
  } catch (error) {
    logger?.debug?.(
      { path, error: error instanceof Error ? error.message : String(error) },
      'could not tighten index.db permissions',
    );
  }
}

/**
 * Reads a `meta` value by key, or null when absent.
 */
export function getMeta(db: DatabaseSync, key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
    | { value: string | null }
    | undefined;
  return row?.value ?? null;
}

/**
 * Upserts a `meta` key/value pair.
 */
export function setMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}
