/**
 * Scheduler daemon (FEAT-021 TASK-002).
 *
 * A lightweight local service — **not** a server rewrite (plan §7). On start it
 * acquires a single-instance lock, then on a fixed poll interval it re-reads the
 * enabled schedules from the store (so `yantra schedule`/`unschedule` edits
 * apply without a restart), computes which are due, and dispatches each fire
 * through the injected `fire` function (the TASK-003 fire-runner) — driving the
 * same inline executor an interactive `yantra run` uses.
 *
 * Policies (feature spec §2, constant by design):
 *   - **Missed fires** (due while the daemon was down) are **skipped**, marked
 *     `last_status: 'missed'` — browsing tasks don't want catch-up bursts.
 *   - **Overlap**: a schedule never runs concurrently with itself; if its prior
 *     fire is still in flight at the next due time, the fire is skipped + logged.
 *
 * Cron parsing/next-fire is delegated to `croner` via {@link ./cron.js}; the
 * daemon owns the *policy* around when to fire, which keeps missed/overlap
 * handling testable with a fake clock rather than real wall-clock timers.
 */

import type { Logger } from '../browser/types.js';
import type { LastFireStatus, Schedule, ScheduleStore } from '../index-db/schedule-store.js';

import { nextFire, nextFireIso } from './cron.js';
import type { DaemonLock } from './daemon-lock.js';

/** Outcome the injected fire-runner reports back for one fire. */
export interface FireResult {
  /** The run id produced (null when the run never got a directory). */
  readonly runId: string | null;
  /** Terminal status of the fire. */
  readonly status: LastFireStatus;
}

/**
 * Fires one schedule: constructs the task, drives the executor, writes
 * artifacts, records history, and notifies. Injected so the daemon lifecycle is
 * testable without a live browser (TASK-003 supplies the real implementation).
 */
export type FireFn = (schedule: Schedule, firedAt: Date) => Promise<FireResult>;

/**
 * Checks a parked run (last fire was `pending-confirmation`) for an out-of-band
 * consent decision and, if the human granted it, resumes the run unattended
 * (plan §6 poll-pickup). Returns the settled status, or `null` when the run is
 * still parked (no decision yet). Injected so the daemon can drive resume
 * without importing the orchestrator (TASK-004 supplies the real one).
 */
export type ResumeParkedFn = (schedule: Schedule) => Promise<FireResult | null>;

/** Injected clock, defaulting to the system clock. */
export interface DaemonClock {
  now(): Date;
}

/** Constructor dependencies for {@link SchedulerDaemon}. */
export interface SchedulerDaemonDeps {
  readonly store: ScheduleStore;
  readonly lock: DaemonLock;
  readonly fire: FireFn;
  /**
   * Optional resumer for parked runs (plan §6 poll-pickup). When provided, each
   * poll checks `pending-confirmation` schedules for a granted decision and
   * resumes them unattended. Omitting it leaves parked runs parked until an
   * interactive `yantra confirm` + `yantra resume`.
   */
  readonly resumeParked?: ResumeParkedFn;
  readonly logger: Logger;
  /** Poll interval in ms for re-syncing schedules + checking due fires (default 60_000). */
  readonly pollIntervalMs?: number;
  readonly clock?: DaemonClock;
  /** Injectable timers for deterministic tests (defaults to global set/clearInterval). */
  readonly timers?: {
    setInterval(fn: () => void, ms: number): { unref?(): void };
    clearInterval(handle: unknown): void;
  };
}

/** Runtime status snapshot for `yantra daemon status`. */
export interface DaemonStatus {
  readonly running: boolean;
  readonly pid: number | null;
  readonly schedulesLoaded: number;
  readonly nextFires: readonly { readonly id: string; readonly nextFireAt: string | null }[];
  readonly pendingConfirmations: number;
}

/**
 * The daemon lifecycle: `start()` acquires the lock and begins the poll loop;
 * `stop()` releases the lock after the in-flight fire (if any) settles.
 *
 * The same object is used for the foreground (`--foreground`) run; the detached
 * spawn and the CLI `start|stop|status` verbs are the connector glue on top.
 */
export class SchedulerDaemon {
  private readonly store: ScheduleStore;
  private readonly lock: DaemonLock;
  private readonly fire: FireFn;
  private readonly resumeParked: ResumeParkedFn | null;
  private readonly logger: Logger;
  private readonly pollIntervalMs: number;
  private readonly clock: DaemonClock;
  private readonly timers: NonNullable<SchedulerDaemonDeps['timers']>;

  private release: (() => Promise<void>) | null = null;
  private handle: { unref?(): void } | null = null;
  /** Ids currently executing a fire — the overlap guard. */
  private readonly inFlight = new Set<string>();
  /** Resolves once every in-flight fire has settled (graceful shutdown). */
  private stopping = false;

  public constructor(deps: SchedulerDaemonDeps) {
    this.store = deps.store;
    this.lock = deps.lock;
    this.fire = deps.fire;
    this.resumeParked = deps.resumeParked ?? null;
    this.logger = deps.logger;
    this.pollIntervalMs = deps.pollIntervalMs ?? 60_000;
    this.clock = deps.clock ?? { now: () => new Date() };
    this.timers = deps.timers ?? {
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (h) => clearInterval(h as NodeJS.Timeout),
    };
  }

  /**
   * Acquires the single-instance lock, records any missed fires as `missed`,
   * then arms the poll loop. Throws {@link DaemonLockHeldError} if another live
   * instance holds the lock.
   */
  public async start(pid: number = process.pid): Promise<void> {
    this.release = await this.lock.acquire(pid);
    this.logger.info({ pid, pollIntervalMs: this.pollIntervalMs }, 'scheduler daemon started');

    await this.markMissedFiresOnStart();

    // The real interval intentionally keeps the event loop alive — that is what
    // makes `yantra daemon start --foreground` a long-running process. Tests
    // inject a manual timer harness, so no test hangs on it.
    const handle = this.timers.setInterval(() => {
      void this.tick();
    }, this.pollIntervalMs);
    this.handle = handle;
  }

  /**
   * Stops the poll loop, waits for any in-flight fire to settle, then releases
   * the lock. Idempotent.
   */
  public async stop(): Promise<void> {
    if (this.stopping) {
      return;
    }
    this.stopping = true;

    if (this.handle !== null) {
      this.timers.clearInterval(this.handle);
      this.handle = null;
    }

    // Wait for in-flight fires to settle (graceful shutdown — feature spec §2).
    await this.drain();

    if (this.release !== null) {
      await this.release().catch(() => undefined);
      this.release = null;
    }
    this.logger.info({}, 'scheduler daemon stopped');
  }

  /**
   * One poll cycle: re-read enabled schedules (picking up CLI edits) and fire
   * any that are due, respecting the overlap guard. Public for deterministic
   * testing with a fake clock.
   */
  public async tick(): Promise<void> {
    if (this.stopping) {
      return;
    }

    const listed = await this.store.listEnabled();
    if (!listed.isOk) {
      // Store failures keep the daemon alive — skip this cycle, warn (§6).
      this.logger.warn({ error: listed.error.message }, 'schedule poll failed; skipping cycle');
      return;
    }

    const now = this.clock.now();
    for (const schedule of listed.value) {
      // Poll-pickup: a run parked for confirmation that a human has since
      // granted (out-of-band via `yantra confirm`) resumes here, unattended and
      // safely (plan §6). A schedule that is still parked is left as-is.
      if (schedule.lastStatus === 'pending-confirmation') {
        void this.resumeIfGranted(schedule);
        continue;
      }

      const dueTime = this.dueTime(schedule, now);
      if (dueTime !== null) {
        // Fire in the background so a long run doesn't block the poll loop; the
        // overlap guard prevents a second concurrent fire of the same schedule.
        // `firedAt` is the scheduled instant (not the poll time) so `last_fire`
        // and the recomputed next fire stay aligned to the cron grid.
        void this.dispatch(schedule, dueTime);
      }
    }
  }

  /** Snapshot for `yantra daemon status`. */
  public async status(): Promise<DaemonStatus> {
    const info = await this.lock.probe();
    const listed = await this.store.list();
    const schedules = listed.isOk ? listed.value : [];
    const now = this.clock.now();
    return {
      running: info !== null,
      pid: info?.pid ?? null,
      schedulesLoaded: schedules.length,
      nextFires: schedules.map((s) => ({
        id: s.id,
        nextFireAt: s.enabled ? nextFireIso(s.cronExpr, now) : null,
      })),
      pendingConfirmations: schedules.filter((s) => s.lastStatus === 'pending-confirmation').length,
    };
  }

  // ---- internals ---------------------------------------------------------

  /**
   * Returns the scheduled fire instant that is currently due (at or before
   * `now` and strictly after the schedule's `last_fire_at`), or null when the
   * schedule is not due. A never-fired schedule uses `created_at` as the lower
   * bound. Returns null while a prior fire of the same schedule is in flight
   * (the overlap guard).
   */
  private dueTime(schedule: Schedule, now: Date): Date | null {
    if (this.inFlight.has(schedule.id)) {
      return null; // overlap guard — still running
    }
    const lastFire = schedule.lastFireAt !== null ? new Date(schedule.lastFireAt) : null;
    const lowerBound = lastFire ?? new Date(schedule.createdAt);
    const dueTime = nextFire(schedule.cronExpr, lowerBound);
    if (dueTime === null || dueTime.getTime() > now.getTime()) {
      return null;
    }
    return dueTime;
  }

  /**
   * Poll-pickup for a parked run: asks the injected resumer whether the run's
   * confirmation was granted out-of-band and, if so, resumes it and records the
   * settled outcome. A still-parked run (resumer returns null) is left as-is.
   * Guarded by the overlap set so a resume and a re-fire can't race.
   */
  private async resumeIfGranted(schedule: Schedule): Promise<void> {
    if (this.resumeParked === null || this.inFlight.has(schedule.id)) {
      return;
    }
    this.inFlight.add(schedule.id);
    try {
      const result = await this.resumeParked(schedule);
      if (result === null) {
        return; // still parked — no decision yet
      }
      this.logger.info(
        { id: schedule.id, runId: result.runId, status: result.status },
        'parked run resumed after out-of-band grant',
      );
      // Preserve the schedule's cron cadence: only update the status/run id,
      // keep the existing last_fire_at so the next fire time is unchanged.
      const marked = await this.store.markFire(schedule.id, {
        lastFireAt: schedule.lastFireAt ?? this.clock.now().toISOString(),
        lastRunId: result.runId,
        lastStatus: result.status,
        nextFireAt: nextFireIso(
          schedule.cronExpr,
          schedule.lastFireAt !== null ? new Date(schedule.lastFireAt) : this.clock.now(),
        ),
      });
      if (!marked.isOk) {
        this.logger.warn(
          { id: schedule.id, error: marked.error.message },
          'failed to persist resumed run outcome',
        );
      }
    } catch (error) {
      this.logger.error(
        { id: schedule.id, error: error instanceof Error ? error.message : String(error) },
        'parked-run resume threw',
      );
    } finally {
      this.inFlight.delete(schedule.id);
    }
  }

  /** Runs one fire under the overlap guard and records its outcome. */
  private async dispatch(schedule: Schedule, firedAt: Date): Promise<void> {
    if (this.inFlight.has(schedule.id)) {
      this.logger.warn(
        { id: schedule.id, workflowName: schedule.workflowName },
        'overlap: prior fire still running, skipping',
      );
      return;
    }
    this.inFlight.add(schedule.id);
    this.logger.info(
      { id: schedule.id, workflowName: schedule.workflowName, firedAt: firedAt.toISOString() },
      'schedule fired',
    );
    try {
      const result = await this.fire(schedule, firedAt);
      await this.recordFire(schedule, firedAt, result.status, result.runId);
    } catch (error) {
      this.logger.error(
        { id: schedule.id, error: error instanceof Error ? error.message : String(error) },
        'fire threw; recording as failed',
      );
      await this.recordFire(schedule, firedAt, 'failed', null);
    } finally {
      this.inFlight.delete(schedule.id);
    }
  }

  /** Persists the fire outcome + recomputed advisory next fire onto the row. */
  private async recordFire(
    schedule: Schedule,
    firedAt: Date,
    status: LastFireStatus,
    runId: string | null,
  ): Promise<void> {
    const marked = await this.store.markFire(schedule.id, {
      lastFireAt: firedAt.toISOString(),
      lastRunId: runId,
      lastStatus: status,
      nextFireAt: nextFireIso(schedule.cronExpr, firedAt),
    });
    if (!marked.isOk) {
      this.logger.warn(
        { id: schedule.id, error: marked.error.message },
        'failed to persist fire outcome',
      );
    }
  }

  /**
   * On start, any schedule whose fire was due while the daemon was down is
   * recorded as `missed` (skipped, not caught up) and its clock advanced so the
   * next real fire is the next future occurrence.
   */
  private async markMissedFiresOnStart(): Promise<void> {
    const listed = await this.store.listEnabled();
    if (!listed.isOk) {
      this.logger.warn({ error: listed.error.message }, 'missed-fire scan failed on start');
      return;
    }
    const now = this.clock.now();
    for (const schedule of listed.value) {
      if (this.dueTime(schedule, now) !== null) {
        this.logger.warn(
          { id: schedule.id, workflowName: schedule.workflowName },
          'missed fire while daemon was down — skipping (catch-up disabled)',
        );
        await this.recordFire(schedule, now, 'missed', null);
      }
    }
  }

  /** Waits until no fire is in flight (bounded busy-wait via the injected clock). */
  private async drain(): Promise<void> {
    // Fires resolve their own promises; we simply await the set to empty. Use a
    // microtask yield loop rather than a timer so fake-timer tests still drain.
    while (this.inFlight.size > 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
}
