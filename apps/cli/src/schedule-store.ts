/**
 * CLI-side helper for opening the schedule registry.
 *
 * Unlike `history.ts` (whose table is a rebuildable cache), the `schedules`
 * table is authored state — losing it loses the registered schedules — so the
 * helper opens the index without a rebuild hook and surfaces a clear error when
 * the index is unavailable rather than silently degrading.
 */

import { SqliteScheduleStore, openIndexDb, type Logger, type ScheduleStore } from '@yantra/core';

/** An open schedule store plus a close handle. */
export interface OpenScheduleStore {
  readonly store: ScheduleStore;
  /** Releases the underlying SQLite handle. Idempotent, never throws. */
  readonly close: () => void;
}

/**
 * Opens the index and returns a {@link ScheduleStore}, or `null` when the index
 * cannot be opened (missing platform support, bad permissions).
 *
 * @param logger - Optional logger for corruption/permission diagnostics.
 */
export async function openScheduleStore(logger?: Logger): Promise<OpenScheduleStore | null> {
  try {
    const { db } = await openIndexDb(logger ? { logger } : {});
    return {
      store: new SqliteScheduleStore({ db, ...(logger ? { logger } : {}) }),
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
      'schedule index unavailable',
    );
    return null;
  }
}
