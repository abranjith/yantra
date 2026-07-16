/**
 * Production wiring for the scheduler daemon (FEAT-021 TASK-002/003).
 *
 * `buildDaemon` assembles a {@link SchedulerDaemon} whose `fire` function drives
 * the real {@link RunOrchestrator} — the same inline executor an interactive
 * `yantra run` uses — through the fire-runner. The confirmation connector is the
 * `DaemonConfirmationGateway` (park-and-notify), so a scheduled fire can never
 * self-authorize a `requires_confirmation` step (plan §6).
 */

import {
  FileDaemonLock,
  SchedulerDaemon,
  SinkNotifier,
  PreGrantedConfirmationGateway,
  createConfirmationStore,
  resolveParkedRun,
  runScheduledFire,
  runsRoot,
  type FireResult,
  type FireRunOutcome,
  type LastFireStatus,
  type Logger,
  type Schedule,
} from '@yantra/core';
import type { ConfirmationGateway } from '@yantra/core';
import { exitCodeFor, type RunRequest } from '@yantra/core/workflow/replay';

import { openHistory } from '../history.js';
import { buildOrchestratorRuntime } from '../runtime.js';
import { openScheduleStore } from '../schedule-store.js';

/** An assembled daemon plus a close handle releasing its open resources. */
export interface BuiltDaemon {
  readonly daemon: SchedulerDaemon;
  /** Releases the schedule store + history index handles. Idempotent. */
  readonly close: () => void;
}

/**
 * Builds the production daemon, or `null` when the index (index.db) is
 * unavailable — a schedule registry requires it.
 *
 * @param logger - Logger for daemon + fire diagnostics.
 * @param pollIntervalMs - Poll cadence (default 60s in the daemon).
 */
export async function buildDaemon(
  logger: Logger,
  pollIntervalMs?: number,
): Promise<BuiltDaemon | null> {
  const scheduleHandle = await openScheduleStore(logger);
  if (scheduleHandle === null) {
    return null;
  }
  const historyHandle = await openHistory(logger);
  const notifier = new SinkNotifier({ logger });

  const daemon = new SchedulerDaemon({
    store: scheduleHandle.store,
    lock: new FileDaemonLock(),
    logger,
    ...(pollIntervalMs !== undefined ? { pollIntervalMs } : {}),
    fire: (schedule: Schedule, firedAt: Date): Promise<FireResult> =>
      runScheduledFire(schedule, firedAt, {
        driver: makeOrchestratorDriver(logger),
        history: historyHandle?.store ?? null,
        notifier,
        logger,
      }),
    // Poll-pickup: resume runs a human has granted out-of-band (plan §6).
    resumeParked: (schedule: Schedule): Promise<FireResult | null> =>
      resolveParkedRun(schedule.lastRunId, {
        reader: createConfirmationStore(`${runsRoot()}/${schedule.lastRunId}`),
        resume: makeResumeDriver(logger),
        logger,
      }),
  });

  return {
    daemon,
    close: () => {
      scheduleHandle.close();
      historyHandle?.close();
    },
  };
}

/**
 * A {@link FireRunDriver} that runs a workflow through a freshly-built
 * orchestrator runtime, injecting the park-and-notify confirmation gateway.
 *
 * A new runtime is built per fire so each run gets its own browser + stores,
 * exactly as separate interactive `yantra run` invocations would.
 */
function makeOrchestratorDriver(logger: Logger): {
  run(request: {
    readonly workflowName: string;
    readonly params: Readonly<Record<string, string>>;
    readonly confirmationGateway: ConfirmationGateway;
  }): Promise<FireRunOutcome>;
} {
  return {
    async run(request): Promise<FireRunOutcome> {
      const runtime = await buildOrchestratorRuntime({
        logger,
        confirmationGateway: request.confirmationGateway,
      });
      try {
        const runRequest: RunRequest = {
          workflowName: request.workflowName,
          params: request.params,
          budgets: {},
          json: false,
          debug: false,
        };
        const outcome = await runtime.orchestrator.run(runRequest);
        if (outcome.kind === 'aborted') {
          return { kind: 'aborted', runId: outcome.runId, reason: outcome.reason };
        }
        return { kind: outcome.kind, runId: outcome.runId };
      } finally {
        runtime.close();
      }
    },
  };
}

/**
 * A resume driver that resumes a parked run through a fresh orchestrator. The
 * confirmation gateway is `null` here: the pending request already has a
 * human-granted decision on disk, so the executor consumes it without asking
 * again (the grant is single-use, step-scoped — FEAT-019).
 */
function makeResumeDriver(logger: Logger): {
  resume(runId: string): Promise<{ status: LastFireStatus; runId: string }>;
} {
  return {
    async resume(runId): Promise<{ status: LastFireStatus; runId: string }> {
      // Replay the human's prior `yantra confirm` grant so the executor's
      // re-request on resume is satisfied exactly once (never auto-created).
      const runtime = await buildOrchestratorRuntime({
        logger,
        confirmationGateway: new PreGrantedConfirmationGateway({ logger }),
      });
      try {
        const outcome = await runtime.orchestrator.resume(runId);
        return { runId: outcome.runId, status: mapResumeStatus(outcome, exitCodeFor(outcome)) };
      } finally {
        runtime.close();
      }
    },
  };
}

/** Maps a resumed run's outcome to the schedule's terminal status. */
function mapResumeStatus(
  outcome: { kind: 'success' | 'failure' | 'aborted'; reason?: string },
  _exitCode: number,
): LastFireStatus {
  if (outcome.kind === 'success') return 'succeeded';
  if (outcome.kind === 'aborted') {
    return outcome.reason === 'user-handoff' || outcome.reason === 'user-abort'
      ? 'handoff'
      : 'failed';
  }
  return 'failed';
}
