/**
 * Schedule-link sidecar (FEAT-021 TASK-006 audit narration; plan §10).
 *
 * When a fire runs, the fire-runner drops a small `schedule.json` into the run
 * directory recording that this run was produced by a schedule — its id, cron,
 * the instant it fired, and the terminal status. `yantra audit <run-id>` reads
 * it to narrate the schedule linkage ("Fired by schedule … on the … cron;
 * paused-and-notified for confirmation."), satisfying plan §10 without
 * broadening the protocol `TaskEvent` union.
 *
 * Secret-free by construction: it holds only the schedule id, workflow name,
 * cron string, timestamps, and status — never params or captured content.
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { runsRoot } from '../browser/paths.js';
import type { Logger } from '../browser/types.js';
import type { LastFireStatus } from '../index-db/schedule-store.js';

/** The `schedule.json` sidecar written into a scheduled run's directory. */
export interface ScheduleLink {
  readonly schedule_id: string;
  readonly workflow_name: string;
  readonly cron_expr: string;
  readonly fired_at: string;
  readonly status: LastFireStatus;
}

/** Filename of the sidecar within a run dir. */
export const SCHEDULE_LINK_FILE = 'schedule.json';

/**
 * Writes the schedule-link sidecar into a run directory (best-effort — a lost
 * sidecar only costs audit narration, never the run).
 *
 * @param runId - The run whose directory receives the sidecar.
 * @param link - The schedule linkage record.
 * @param opts - Optional runs-dir override (tests) + logger.
 */
export async function writeScheduleLink(
  runId: string,
  link: ScheduleLink,
  opts: { runsDir?: string; logger?: Logger } = {},
): Promise<void> {
  const runsDir = opts.runsDir ?? runsRoot();
  const path = join(runsDir, runId, SCHEDULE_LINK_FILE);
  try {
    await writeFile(path, JSON.stringify(link, null, 2), { encoding: 'utf8', mode: 0o600 });
  } catch (error) {
    opts.logger?.debug?.(
      { runId, error: error instanceof Error ? error.message : String(error) },
      'failed to write schedule.json sidecar',
    );
  }
}
