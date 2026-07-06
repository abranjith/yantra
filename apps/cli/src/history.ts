/**
 * CLI-side helpers for the local task-history index.
 *
 * The index is an **optional cache** (plan §7): every helper here degrades to a
 * no-op / null rather than failing a command when `index.db` is unavailable.
 * Recording a completed task reads the canonical `runs/<id>/manifest.json` the
 * pipeline just wrote, so the index stays a faithful mirror of the files.
 */

import { SqliteHistoryStore, openIndexDb, type HistoryStore, type Logger } from '@yantra/core';

/** An open history store plus a close handle. */
export interface OpenHistory {
  readonly store: HistoryStore;
  /** Releases the underlying SQLite handle. Idempotent, never throws. */
  readonly close: () => void;
}

/**
 * Opens the index and returns a {@link HistoryStore}, or `null` when the index
 * cannot be opened (missing platform support, bad permissions). A corrupt DB is
 * transparently rebuilt from the run tree before returning.
 */
export async function openHistory(logger?: Logger): Promise<OpenHistory | null> {
  try {
    const { db } = await openIndexDb({
      ...(logger ? { logger } : {}),
      rebuild: async (fresh) => {
        await new SqliteHistoryStore({ db: fresh }).rebuildFromRuns();
      },
    });
    return {
      store: new SqliteHistoryStore({ db, ...(logger ? { logger } : {}) }),
      close: () => {
        try {
          db.close();
        } catch {
          // best-effort
        }
      },
    };
  } catch (error) {
    logger?.debug?.(
      { error: error instanceof Error ? error.message : String(error) },
      'history index unavailable',
    );
    return null;
  }
}

/**
 * Best-effort recording of a completed task from its run directory. Never
 * throws and never fails the calling command — a lost history row is a cache
 * miss, not an error.
 *
 * @param runId - The run directory name (also `brief.metadata.run_id`).
 */
export async function recordTaskHistory(runId: string, logger?: Logger): Promise<void> {
  const handle = await openHistory(logger);
  if (handle === null) {
    return;
  }
  try {
    const result = await handle.store.recordFromRunDir(runId);
    if (!result.isOk) {
      logger?.debug?.({ runId, error: result.error.message }, 'history record failed');
    }
  } finally {
    handle.close();
  }
}
