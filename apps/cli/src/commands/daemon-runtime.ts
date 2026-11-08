import { resolve } from 'node:path';

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
  ConfigBrowserSelectionReader,
  receiptLockOptions,
  type ExecutionReceiptDraft,
  type FireRunDriver,
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
import {
  LocalRunStore,
  loadResumePoint,
  exitCodeFor,
  type RunRequest,
} from '@yantra/core/workflow/replay';
import { JsonValue, PROTOCOL_VERSION } from '@yantra/protocol';

import { replayContent } from '../context/replay-content.js';
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
  options: { readonly cwd?: string } = {},
): Promise<BuiltDaemon | null> {
  const cwd = options.cwd ?? resolve('.');
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
        receipt: (schedule) =>
          daemonReceipt(schedule.workflowName, schedule.params, cwd, schedule.cronExpr),
        history: historyHandle?.store ?? null,
        notifier,
        logger,
      }),
    // Poll-pickup: resume runs a human has granted out-of-band (plan §6).
    resumeParked: (schedule: Schedule): Promise<FireResult | null> =>
      resolveParkedRun(schedule.lastRunId, {
        reader: createConfirmationStore(`${runsRoot()}/${schedule.lastRunId}`),
        resume: makeResumeDriver(logger, cwd),
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
function makeOrchestratorDriver(logger: Logger): FireRunDriver {
  return {
    async run(request): Promise<FireRunOutcome> {
      const runtime = await buildOrchestratorRuntime({
        logger,
        // Unattended fires can report install guidance but never authorize a download.
        browser: {
          installOfferGateway: null,
          resourceLockOptions: { ...receiptLockOptions(request.receipt), logger },
        },
        confirmationGateway: request.confirmationGateway,
        // Hard zero-LLM: a scheduled fire is unattended, so it never opens a
        // provider session regardless of how the workflow or environment is
        // configured. A workflow declaring `synthesis:` still gets a Brief —
        // composed deterministically.
        synthesis: { llm: null, noLlm: true },
      });
      try {
        const runRequest: RunRequest = {
          ...(request.receipt ? { receipt: request.receipt } : {}),
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
function makeResumeDriver(
  logger: Logger,
  cwd: string,
): {
  resume(runId: string): Promise<{ status: LastFireStatus; runId: string }>;
} {
  return {
    async resume(runId): Promise<{ status: LastFireStatus; runId: string }> {
      const { manifest } = await loadResumePoint(new LocalRunStore(), runId);
      const receipt = await daemonReceipt(manifest.workflowName, manifest.params, cwd);
      // Replay the human's prior `yantra confirm` grant so the executor's
      // re-request on resume is satisfied exactly once (never auto-created).
      const runtime = await buildOrchestratorRuntime({
        logger,
        // A resumed scheduled run remains unattended and cannot prompt for acquisition.
        browser: {
          installOfferGateway: null,
          resourceLockOptions: { ...receiptLockOptions(receipt), logger },
        },
        confirmationGateway: new PreGrantedConfirmationGateway({ logger }),
        // Hard zero-LLM, as on the fire path: resuming a parked scheduled run is
        // still an unattended surface.
        synthesis: { llm: null, noLlm: true },
      });
      try {
        const outcome = await runtime.orchestrator.resume(runId, { receipt });
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

/** Scheduled settings never resolve provider/model flags or environment. */
export async function daemonReceipt(
  workflowName: string,
  params: Readonly<Record<string, unknown>>,
  cwd: string,
  cron?: string,
): Promise<ExecutionReceiptDraft> {
  const configured = await new ConfigBrowserSelectionReader().read();
  return {
    schema_version: 1,
    yantra_version: `${PROTOCOL_VERSION} (yantra cli)`,
    invoked_by: 'daemon',
    invocation_id: null,
    command: ['run'],
    cwd,
    settings: [
      { key: 'params', value: JsonValue.parse(params), source: { kind: 'schedule' } },
      { key: 'llm', value: false, source: { kind: 'schedule' } },
      ...(cron === undefined
        ? []
        : [{ key: 'cron', value: cron, source: { kind: 'schedule' as const } }]),
    ],
    content: await replayContent(workflowName),
    browser: {
      selection: configured ?? { source: 'auto', executablePath: null },
      source: configured ? { kind: 'config', key: 'browser.source' } : { kind: 'default' },
    },
  };
}
