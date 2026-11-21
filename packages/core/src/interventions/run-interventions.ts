/**
 * One intervention wiring for every run owner (plan D12, review REV-002).
 *
 * A run owner's {@link InterventionAuthority} is the only place a live consent
 * request is decided. For that to hold, three things must reach it: answers
 * from the app or `yantra confirm` over the run socket, the host's attendance
 * count (D5), and a sink that records `intervention_raised`/`resolved` in the
 * run's event log. {@link serveInterventionsOnRunSocket} registers the two
 * socket handlers; {@link RunInterventions} keeps one authority per run and
 * binds it to the run's socket and event stream once the owner opens them.
 */

import { join } from 'node:path';

import type { RunEvent } from '@yantra/protocol';

import { runsRoot } from '../browser/paths.js';
import type { ChannelHandler } from '../run-channel/server.js';

import { InterventionAuthority, type InterventionEventSink } from './authority.js';
import { UnattendedCeilingClock } from './deadline.js';
import { InterventionLog } from './intervention-log.js';

/** The part of an ownership session the intervention handlers need. */
export interface InterventionChannelHost {
  registerChannelHandler(type: string, capability: string | null, handler: ChannelHandler): void;
}

/** The capability a client must hold to send interventions messages. */
export const INTERVENTIONS_CAPABILITY = 'interventions';

/**
 * Registers `attendance` and `intervention.answer` on a run socket. Every
 * answer goes through `authority.answer`, so it is decided exactly once.
 */
export function serveInterventionsOnRunSocket(
  host: InterventionChannelHost,
  authority: Pick<InterventionAuthority, 'answer' | 'setAttendance'>,
): void {
  host.registerChannelHandler('attendance', INTERVENTIONS_CAPABILITY, (message, connection) => {
    const count =
      typeof message.count === 'number' && Number.isInteger(message.count) ? message.count : null;
    if (count === null || count < 0) {
      connection.send({ type: 'error', code: 'bad_request', message: 'attendance' });
      return;
    }
    void authority.setAttendance(count);
  });
  host.registerChannelHandler(
    'intervention.answer',
    INTERVENTIONS_CAPABILITY,
    (message, connection) => {
      const interventionId =
        typeof message.intervention_id === 'string' ? message.intervention_id : null;
      const decision =
        message.decision === 'granted' || message.decision === 'denied' ? message.decision : null;
      const decidedBy =
        message.decided_by === 'user_app' || message.decided_by === 'user_cli_confirm'
          ? message.decided_by
          : null;
      if (interventionId === null || decision === null || decidedBy === null) {
        connection.send({ type: 'error', code: 'bad_request', message: 'intervention.answer' });
        return;
      }
      authority.answer({ interventionId, decision, decidedBy }).then(
        (response) => {
          connection.send({
            type: 'intervention.response',
            intervention_id: interventionId,
            response,
          });
        },
        () => {
          connection.send({ type: 'error', code: 'bad_request', message: 'intervention.answer' });
        },
      );
    },
  );
}

/** What an owner hands over once the run's socket and event log exist. */
export interface RunInterventionBinding {
  /** The run socket; omitted when the run has no ownership session. */
  readonly channel?: InterventionChannelHost;
  /** The run's event log. */
  readonly events?: InterventionEventSink;
}

/** A gateway that can be bound to the run it is answering for. */
export interface RunBindableGateway {
  attachRun(runId: string, binding: RunInterventionBinding): void;
}

/** True when `gateway` accepts a {@link RunInterventionBinding}. */
export function isRunBindable(gateway: unknown): gateway is RunBindableGateway {
  return (
    typeof gateway === 'object' &&
    gateway !== null &&
    typeof (gateway as Partial<RunBindableGateway>).attachRun === 'function'
  );
}

export interface RunInterventionsOptions {
  /**
   * Attendance before the host reports any. A terminal with a person at the
   * prompt starts at 1; a worker starts at 0 and the host's `attendance`
   * messages drive it from there.
   */
  readonly initialAttendance: number;
  /** Called once per authority, e.g. to attach a `NeedsYouNotifier`. */
  readonly onAuthority?: (authority: InterventionAuthority, runId: string) => void;
  readonly now?: () => number;
  /** Where run directories live (default: the configured runs root). */
  readonly runsRoot?: () => string;
}

interface RunEntry {
  readonly authority: InterventionAuthority;
  readonly sink: ForwardingSink;
  channelBound: boolean;
}

/** See the module comment. */
export class RunInterventions implements RunBindableGateway {
  private readonly runs = new Map<string, RunEntry>();

  public constructor(private readonly options: RunInterventionsOptions) {}

  /** The run's authority, created on first use. */
  public authorityFor(runId: string): InterventionAuthority {
    return this.entry(runId).authority;
  }

  /**
   * Binds the run's authority to its socket and event log. A second channel
   * binding for the same run is ignored, so handlers register once.
   */
  public attachRun(runId: string, binding: RunInterventionBinding): void {
    const entry = this.entry(runId);
    if (binding.events !== undefined) entry.sink.target = binding.events;
    if (binding.channel !== undefined && !entry.channelBound) {
      entry.channelBound = true;
      serveInterventionsOnRunSocket(binding.channel, entry.authority);
    }
  }

  private entry(runId: string): RunEntry {
    const existing = this.runs.get(runId);
    if (existing !== undefined) return existing;
    const now = this.options.now ?? Date.now;
    const ceiling = new UnattendedCeilingClock({ now });
    ceiling.setAttendance(this.options.initialAttendance);
    const sink = new ForwardingSink();
    const root = (this.options.runsRoot ?? runsRoot)();
    const authority = new InterventionAuthority({
      runId,
      log: new InterventionLog(join(root, runId, 'interventions.jsonl')),
      events: sink,
      clock: { now: () => new Date(now()).toISOString() },
      ceiling,
    });
    const entry: RunEntry = { authority, sink, channelBound: false };
    this.runs.set(runId, entry);
    this.options.onAuthority?.(authority, runId);
    return entry;
  }
}

/** Publishes to the run's event log once bound; drops events before that. */
class ForwardingSink implements InterventionEventSink {
  public target: InterventionEventSink | null = null;

  public publish(event: RunEvent): void {
    this.target?.publish(event);
  }

  public flush(): Promise<void> {
    return this.target?.flush() ?? Promise.resolve();
  }
}
