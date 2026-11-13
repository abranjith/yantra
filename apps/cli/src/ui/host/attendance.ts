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

import { EmptyParams } from '@yantra/protocol';

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

  /** Forwards an intervention event of an attached run to subscribed windows. */
  public forward(runId: string, seq: number, event: unknown): void {
    const kind = (event as { kind?: unknown } | null)?.kind;
    if (kind !== 'intervention_raised' && kind !== 'intervention_resolved') return;
    for (const attendee of this.attendees.values()) {
      if (attendee.open)
        attendee.connection.notify('intervention.event', { run_id: runId, seq, event });
    }
  }

  /** Registers `interventions.subscribe` and `attendance.heartbeat`. */
  public register(methods: RpcMethodRegistry): void {
    methods
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
