/**
 * Fire runner (FEAT-021 TASK-003) — executes one scheduled fire.
 *
 * A scheduled fire is "just another connector constructing a Task and driving
 * the same executor" (plan §7): it builds a `RunRequest` from the schedule,
 * runs it through the standard {@link RunOrchestrator} (same ethics gate,
 * keychain, stores, artifacts), records the run into history, updates the
 * schedule row, and notifies. The only difference from an interactive `yantra
 * run` is the confirmation connector — an unattended fire uses the
 * {@link DaemonConfirmationGateway}, which parks-and-notifies rather than ever
 * granting consent (plan §6).
 *
 * The runner is dependency-injected end to end so the daemon lifecycle and the
 * chaos/e2e suites can exercise it over a fake orchestrator without a browser.
 */

import type { Logger } from '../browser/types.js';
import type { ConfirmationGateway } from '../executor/confirmation-gateway.js';
import type { HistoryStore } from '../index-db/history-store.js';
import type { LastFireStatus, Schedule } from '../index-db/schedule-store.js';

import { DaemonConfirmationGateway } from './daemon-confirmation-gateway.js';
import type { FireResult } from './daemon.js';
import { buildNotification, type Notifier } from './notify.js';
import { writeScheduleLink } from './schedule-link.js';

/** The subset of the orchestrator outcome the fire-runner reacts to. */
export interface FireRunOutcome {
  readonly kind: 'success' | 'failure' | 'aborted';
  readonly runId: string;
  /** For aborted outcomes, the reason (distinguishes user-handoff/park). */
  readonly reason?: 'user-handoff' | 'user-abort' | 'scope-violation' | 'ethics-refused';
}

/** A run driver — abstracts {@link RunOrchestrator.run} for testability. */
export interface FireRunDriver {
  run(request: {
    readonly workflowName: string;
    readonly params: Readonly<Record<string, string>>;
    readonly confirmationGateway: ConfirmationGateway;
  }): Promise<FireRunOutcome>;
}

/** Dependencies for {@link runScheduledFire}. */
export interface FireRunnerDeps {
  /** Drives the actual run (wraps `RunOrchestrator.run` in production). */
  readonly driver: FireRunDriver;
  /** History index for recording the completed run (optional — best-effort). */
  readonly history?: HistoryStore | null;
  /** Notification sink for completed/failed/parked outcomes. */
  readonly notifier: Notifier;
  readonly logger: Logger;
  readonly clock?: { now(): Date };
  /** Runs-dir override for the schedule-link sidecar (tests). */
  readonly runsDir?: string;
}

/**
 * Runs one fire of a schedule and returns its terminal status + run id.
 *
 * @param schedule - The schedule being fired.
 * @param firedAt - The scheduled instant this fire represents.
 * @param deps - Injected run driver, history store, notifier, logger.
 * @returns The {@link FireResult} the daemon records on the schedule row.
 */
export async function runScheduledFire(
  schedule: Schedule,
  firedAt: Date,
  deps: FireRunnerDeps,
): Promise<FireResult> {
  const gateway = new DaemonConfirmationGateway({
    scheduleId: schedule.id,
    workflowName: schedule.workflowName,
    notifyTarget: schedule.notifyTarget,
    notifier: deps.notifier,
    logger: deps.logger,
    ...(deps.clock ? { clock: deps.clock } : {}),
  });

  let outcome: FireRunOutcome;
  try {
    outcome = await deps.driver.run({
      workflowName: schedule.workflowName,
      params: schedule.params,
      confirmationGateway: gateway,
    });
  } catch (error) {
    deps.logger.error(
      {
        scheduleId: schedule.id,
        error: error instanceof Error ? error.message : String(error),
      },
      'scheduled fire threw',
    );
    // No run id available — notify failure with the workflow name only.
    await notify(deps, schedule, null, 'failed');
    return { runId: null, status: 'failed' };
  }

  const status = classify(outcome, gateway.parked);

  // Drop the schedule-link sidecar so `yantra audit` can narrate the fire
  // (plan §10 — best-effort, secret-free by construction).
  if (outcome.runId.length > 0) {
    await writeScheduleLink(
      outcome.runId,
      {
        schedule_id: schedule.id,
        workflow_name: schedule.workflowName,
        cron_expr: schedule.cronExpr,
        fired_at: firedAt.toISOString(),
        status,
      },
      { ...(deps.runsDir !== undefined ? { runsDir: deps.runsDir } : {}), logger: deps.logger },
    );
  }

  // Record into the history index (best-effort — a lost row is a cache miss).
  if (deps.history && outcome.runId.length > 0) {
    const recorded = await deps.history.recordFromRunDir(outcome.runId);
    if (!recorded.isOk) {
      deps.logger.debug?.(
        { runId: outcome.runId, error: recorded.error.message },
        'history record failed for scheduled fire',
      );
    }
  }

  // The DaemonConfirmationGateway already emitted the confirmation_needed
  // notification when it parked; emit completed/failed here for the others.
  if (status === 'succeeded') {
    await notify(deps, schedule, outcome.runId, 'completed');
  } else if (status === 'failed' || status === 'handoff') {
    await notify(deps, schedule, outcome.runId, 'failed');
  }

  deps.logger.info(
    { scheduleId: schedule.id, runId: outcome.runId, status, firedAt: firedAt.toISOString() },
    'scheduled fire settled',
  );

  return { runId: outcome.runId, status };
}

/**
 * Maps an orchestrator outcome (+ whether the run parked for confirmation) to
 * the schedule's `last_status`.
 *
 * A `user-handoff` abort that parked for confirmation → `pending-confirmation`
 * (a human must resolve it). A `user-handoff` that did NOT park (e.g. a MFA
 * handoff) → `handoff`.
 */
function classify(outcome: FireRunOutcome, parked: boolean): LastFireStatus {
  if (outcome.kind === 'success') {
    return 'succeeded';
  }
  if (outcome.kind === 'aborted') {
    if (parked) {
      return 'pending-confirmation';
    }
    return outcome.reason === 'user-handoff' || outcome.reason === 'user-abort'
      ? 'handoff'
      : 'failed';
  }
  return 'failed';
}

/** Emits a secret-free completed/failed notification for the fire. */
async function notify(
  deps: FireRunnerDeps,
  schedule: Schedule,
  runId: string | null,
  kind: 'completed' | 'failed',
): Promise<void> {
  const notification = buildNotification(
    {
      scheduleId: schedule.id,
      runId,
      workflowName: schedule.workflowName,
      kind,
    },
    deps.clock?.now(),
  );
  try {
    await deps.notifier.notify(notification, schedule.notifyTarget);
  } catch (error) {
    deps.logger.warn(
      { scheduleId: schedule.id, error: error instanceof Error ? error.message : String(error) },
      'fire notification failed',
    );
  }
}
