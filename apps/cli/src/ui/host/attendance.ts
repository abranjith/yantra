/**
 * Attendance (FEAT-065 TASK-018, plan D5): whether a person is watching for
 * interventions, as a count the host relays to every attached worker.
 *
 * A window attends only while it has a live authenticated socket, has called
 * `interventions.subscribe`, and sent `attendance.heartbeat` within the last
 * 30 seconds. Nothing else counts: zero windows means a count of 0, whatever
 * the queue holds or however long the host has been up. The count goes to
 * each worker as `attendance {count}` when it changes, when a worker attaches,
 * and every 10 seconds. Workers record what they do with it (FEAT-068); the
 * host logs only count changes.
 *
 * Subscribed windows also receive `intervention.event` for the
 * `intervention_raised` and `intervention_resolved` events of attached runs.
 * FEAT-068 owns the intervention model and answers.
 */

import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ParkedDecisionService, dataDir, runsRoot } from '@yantra/core';
import { DecisionResponse, EmptyParams, generateUlid, NotificationAttempt } from '@yantra/protocol';
import type { DecisionResponse as DecisionResponseType } from '@yantra/protocol';
import { z } from 'zod';

import { SILENT_HOST_LOGGER, type HostLogger } from './host.js';
import type { RpcConnection, RpcMethodRegistry } from './rpc-server.js';

/** How long a heartbeat keeps a window attending. */
export const ATTENDANCE_TTL_MS = 30_000;
/** How often the count is re-sent to workers. */
export const ATTENDANCE_RESEND_MS = 10_000;

interface Attendee {
  readonly connection: RpcConnection;
  open: boolean;
  lastHeartbeat: number;
}

export interface AttendanceDeps {
  /** Sends the count to every attached worker. */
  readonly broadcast: (count: number) => void;
  /** Sends the count to one worker that just attached. */
  readonly sendTo: (runId: string, count: number) => void;
  readonly answerLive?: (
    runId: string,
    interventionId: string,
    decision: 'granted' | 'denied',
  ) => Promise<DecisionResponseType | null>;
  readonly now?: () => number;
  readonly logger?: HostLogger;
}

/** See the module comment. */
export class Attendance {
  private readonly attendees = new Map<number, Attendee>();
  private readonly now: () => number;
  private readonly logger: HostLogger;
  private lastCount = 0;
  private timer: NodeJS.Timeout | null = null;

  public constructor(private readonly deps: AttendanceDeps) {
    this.now = deps.now ?? Date.now;
    this.logger = deps.logger ?? SILENT_HOST_LOGGER;
  }

  /** Windows attending right now. */
  public count(): number {
    const now = this.now();
    let count = 0;
    for (const attendee of this.attendees.values()) {
      if (attendee.open && now - attendee.lastHeartbeat <= ATTENDANCE_TTL_MS) count += 1;
    }
    return count;
  }

  /** Re-evaluates and sends the count when it changed. */
  public refresh(): number {
    const count = this.count();
    if (count !== this.lastCount) {
      this.lastCount = count;
      this.logger.info({ count }, 'attendance changed');
      this.deps.broadcast(count);
    }
    return count;
  }

  /** A worker attached: it gets the current count at once. */
  public attached(runId: string): void {
    this.deps.sendTo(runId, this.count());
  }

  /** Re-sends every 10 s (and catches heartbeats that lapsed). */
  public start(): void {
    this.timer ??= setInterval(() => {
      const before = this.lastCount;
      const count = this.refresh();
      if (count === before) this.deps.broadcast(count);
    }, ATTENDANCE_RESEND_MS);
    this.timer.unref();
  }

  public stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** Forwards an intervention event and records app-channel delivery attempts. */
  public forward(runId: string, seq: number, event: unknown): void {
    const record = event as { kind?: unknown; intervention_id?: unknown } | null;
    const kind = record?.kind;
    if (kind !== 'intervention_raised' && kind !== 'intervention_resolved') return;
    const open = [...this.attendees.values()].filter((attendee) => attendee.open);
    for (const attendee of open) {
      attendee.connection.notify('intervention.event', { run_id: runId, seq, event });
    }
    if (kind === 'intervention_raised' && typeof record?.intervention_id === 'string') {
      void this.recordAppAttempt(runId, record.intervention_id, open.length > 0);
    }
  }

  private async recordAppAttempt(
    runId: string,
    interventionId: string,
    delivered: boolean,
  ): Promise<void> {
    const path = join(dataDir(), 'notifications.jsonl');
    const at = new Date(this.now()).toISOString();
    const base = {
      record: 'attempt' as const,
      attempt_id: generateUlid(),
      notification_id: null,
      intervention_id: interventionId,
      run_id: runId,
      channel: 'app' as const,
      at,
    };
    const attempted = NotificationAttempt.parse({
      ...base,
      status: 'attempted',
      detail: null,
    });
    const outcome = NotificationAttempt.parse({
      ...base,
      attempt_id: generateUlid(),
      status: delivered ? 'delivered' : 'unsupported',
      detail: delivered ? null : 'no_window',
    });
    await appendFile(path, `${JSON.stringify(attempted)}\n${JSON.stringify(outcome)}\n`, 'utf8');
  }

  /** Registers `interventions.subscribe`, live answers, and heartbeats. */
  public register(methods: RpcMethodRegistry): void {
    methods
      .register('intervention.answer', {
        params: z
          .object({
            run_id: z.string().min(1),
            intervention_id: z.string().min(1),
            decision: z.enum(['granted', 'denied']),
          })
          .strict(),
        result: DecisionResponse,
        handler: async ({ run_id: runId, intervention_id: interventionId, decision }) => {
          const live = await this.deps.answerLive?.(runId, interventionId, decision);
          if (live !== null && live !== undefined) return live;
          return new ParkedDecisionService().decideParked({
            runDir: join(runsRoot(), runId),
            runId,
            decision,
            decidedBy: 'user_app',
          });
        },
      })
      .register('interventions.subscribe', {
        params: EmptyParams,
        result: EmptyParams,
        handler: (_params, { connection }) => {
          if (!this.attendees.has(connection.id)) {
            const attendee: Attendee = { connection, open: true, lastHeartbeat: this.now() };
            this.attendees.set(connection.id, attendee);
            connection.onClose(() => {
              attendee.open = false;
              this.attendees.delete(connection.id);
              this.refresh();
            });
          }
          this.refresh();
          return {};
        },
      })
      .register('attendance.heartbeat', {
        params: EmptyParams,
        result: EmptyParams,
        handler: (_params, { connection }) => {
          const attendee = this.attendees.get(connection.id);
          if (attendee !== undefined) attendee.lastHeartbeat = this.now();
          this.refresh();
          return {};
        },
      });
  }
}
