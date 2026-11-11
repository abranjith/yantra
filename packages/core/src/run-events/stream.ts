/**
 * `RunEventStream` — the in-process face of a run's event log (FEAT-063).
 *
 * Producers call {@link RunEventStream.emit} synchronously; subscribers receive
 * a {@link RunEventDelivery}. The ordering rule is **persist before publish**:
 * once the log is open, every event is appended (write completed) before any
 * subscriber sees it.
 *
 * Two kinds of subscriber:
 *
 * - **Committed** (the default; sockets, tests, app relays) only ever see
 *   appended events, each with its `seq`.
 * - **`includeUncommitted`** (only the owning process's own terminal or JSON
 *   renderer) additionally sees what happens before the log exists — the goal
 *   echo and pre-run warnings, emitted before the run directory does — and
 *   keeps seeing events if the log degrades, so the terminal behaves exactly
 *   as it did before the log existed.
 *
 * Pre-open events are buffered (at most {@link PRE_OPEN_BUFFER_LIMIT}) and
 * committed as the first lines of the log on {@link RunEventStream.open},
 * keeping their original `at`; they are not delivered to an
 * `includeUncommitted` subscriber a second time.
 *
 * A disk fault never aborts the run: an append failure degrades the stream
 * (one structured `run_events_degraded` error), after which only
 * `includeUncommitted` subscribers are served.
 */

import type { RunEventDelivery, RunEventType } from '@yantra/protocol';

import type { Logger } from '../browser/types.js';

import { RunEventLog, RunEventLogError, type RunEventLogScheduler } from './log.js';

/** Most events held before the log opens; the oldest are dropped beyond it. */
export const PRE_OPEN_BUFFER_LIMIT = 64;

/** A run-event subscriber. */
export type RunEventListener = (delivery: RunEventDelivery) => void;

/** Subscription options. */
export interface RunEventSubscribeOptions {
  /**
   * Also receive events that are not (yet, or ever) committed: pre-open events
   * and, after a degradation, every event. Reserved for the owning process's
   * own renderer.
   */
  readonly includeUncommitted?: boolean;
}

/** Options for {@link RunEventStream.open}. */
export interface RunEventStreamOpenOptions {
  readonly runDir: string;
  readonly runId: string;
  /** Replaces the stream's logger for the log's own diagnostics. */
  readonly logger?: Logger;
  /** Durability barrier seam (tests). */
  readonly sync?: (fd: number) => void;
  /** Interval-sync timer seam (tests). */
  readonly scheduler?: RunEventLogScheduler;
  /** Log factory seam (tests inject a failing writer). */
  readonly openLog?: typeof RunEventLog.open;
}

type StreamState = 'pre_open' | 'open' | 'degraded' | 'closed';

interface Subscriber {
  readonly listener: RunEventListener;
  readonly includeUncommitted: boolean;
  readonly index: number;
  failureLogged: boolean;
}

const noopLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

export class RunEventStream {
  private state: StreamState = 'pre_open';
  private log: RunEventLog | null = null;
  private readonly buffer: RunEventType[] = [];
  private dropped = 0;
  private subscribers: Subscriber[] = [];
  private nextIndex = 0;
  private readonly afterCloseLogged = new Set<string>();
  private readonly invalidLogged = new Set<string>();
  private logger: Logger;
  private openedRunId: string | null = null;
  private outcomeSeen = false;

  public constructor(options: { readonly logger?: Logger } = {}) {
    this.logger = options.logger ?? noopLogger;
  }

  /** True once {@link open} succeeded, until {@link close}. Also true while degraded. */
  public get opened(): boolean {
    return this.state === 'open' || this.state === 'degraded';
  }

  /** True after an append failure stopped the log. */
  public get degraded(): boolean {
    return this.state === 'degraded';
  }

  /** True after {@link close}. */
  public get closed(): boolean {
    return this.state === 'closed';
  }

  /**
   * True once a `run_outcome` was emitted in this process (whether or not it
   * was committed); a `task_resumed` starts a new execution and clears it.
   */
  public get outcomeRecorded(): boolean {
    return this.outcomeSeen;
  }

  /**
   * `seq` of the last committed event, or 0 before open. This is the replay
   * watermark a run socket reads, on this event loop, before streaming the
   * file (FEAT-064).
   */
  public get lastSeq(): number {
    return this.log === null ? 0 : this.log.nextSequence - 1;
  }

  /** The run this stream was opened for, or null before open. */
  public get runId(): string | null {
    return this.openedRunId;
  }

  /** Absolute path of the log file, or null before open. */
  public get path(): string | null {
    return this.log?.path ?? null;
  }

  /**
   * Opens the run's log and commits any buffered pre-open events as its first
   * lines, delivering them to committed subscribers only.
   *
   * @throws {RunEventLogError} `RUN_EVENT_LOG_OPEN_FAILED` when the log cannot
   *   be opened: an environment failure before the run proceeds.
   */
  public open(options: RunEventStreamOpenOptions): void {
    if (this.state !== 'pre_open') {
      throw new Error(`RunEventStream.open called in state ${this.state}.`);
    }
    if (options.logger) this.logger = options.logger;
    this.log = (options.openLog ?? RunEventLog.open)({
      runDir: options.runDir,
      runId: options.runId,
      logger: this.logger,
      ...(options.sync === undefined ? {} : { sync: options.sync }),
      ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
    });
    this.openedRunId = options.runId;
    this.state = 'open';
    if (this.dropped > 0) {
      this.logger.warn(
        { event: 'run_events_preopen_overflow', dropped: this.dropped },
        'run_events_preopen_overflow',
      );
    }
    for (const event of this.buffer.splice(0)) {
      const seq = this.append(event);
      if (seq !== null) this.deliver({ seq, committed: true, event }, 'committed');
    }
  }

  /**
   * Emits one event. Before open it is buffered and shown only to
   * `includeUncommitted` subscribers; once open it is appended, then delivered
   * to everyone; after close it is dropped (logged once per kind).
   *
   * @throws {RunEventLogError} `RUN_OUTCOME_DUPLICATE` for a second
   *   `run_outcome`, which is a producer bug, never a disk fault.
   */
  public emit(event: RunEventType): void {
    if (this.state !== 'closed') this.noteSegment(event);
    switch (this.state) {
      case 'pre_open':
        if (this.buffer.length >= PRE_OPEN_BUFFER_LIMIT) {
          this.buffer.shift();
          this.dropped += 1;
        }
        this.buffer.push(event);
        this.deliver({ seq: null, committed: false, event }, 'uncommitted');
        return;
      case 'open': {
        const seq = this.append(event);
        if (seq === null) this.deliver({ seq: null, committed: false, event }, 'uncommitted');
        else this.deliver({ seq, committed: true, event }, 'all');
        return;
      }
      case 'degraded':
        this.deliver({ seq: null, committed: false, event }, 'uncommitted');
        return;
      case 'closed':
        if (!this.afterCloseLogged.has(event.kind)) {
          this.afterCloseLogged.add(event.kind);
          this.logger.warn(
            { event: 'run_events_after_close', kind: event.kind },
            'run_events_after_close',
          );
        }
        return;
    }
  }

  /**
   * Subscribes a listener. A listener that throws is isolated: it is logged
   * once and the run, and every other listener, carry on.
   *
   * @returns An idempotent disposer.
   */
  public subscribe(listener: RunEventListener, options: RunEventSubscribeOptions = {}): () => void {
    const subscriber: Subscriber = {
      listener,
      includeUncommitted: options.includeUncommitted === true,
      index: this.nextIndex++,
      failureLogged: false,
    };
    this.subscribers = [...this.subscribers, subscriber];
    let disposed = false;
    return (): void => {
      if (disposed) return;
      disposed = true;
      this.subscribers = this.subscribers.filter((entry) => entry !== subscriber);
    };
  }

  /** Forces a durability barrier for anything appended so far. */
  public flush(): void {
    if (this.state !== 'open' || this.log === null) return;
    try {
      this.log.flush();
    } catch (error) {
      this.degrade(error);
    }
  }

  /** Syncs and closes the log; idempotent. Later emits are dropped. */
  public close(): void {
    if (this.state === 'closed') return;
    const log = this.log;
    this.state = 'closed';
    this.buffer.length = 0;
    if (log === null || log.closed) return;
    try {
      log.close();
    } catch (error) {
      this.logger.error(
        { event: 'run_events_close_failed', code: errorCode(error) },
        'run_events_close_failed',
      );
    }
  }

  private noteSegment(event: RunEventType): void {
    if (event.kind === 'run_outcome') this.outcomeSeen = true;
    else if (event.kind === 'task_resumed') this.outcomeSeen = false;
  }

  /** Appends one event; returns its seq, or null when it was not committed. */
  private append(event: RunEventType): number | null {
    if (this.log === null) return null;
    try {
      return this.log.append(event);
    } catch (error) {
      if (error instanceof RunEventLogError) {
        if (error.code === 'RUN_OUTCOME_DUPLICATE') throw error;
        if (error.code === 'RUN_EVENT_INVALID') {
          if (!this.invalidLogged.has(event.kind)) {
            this.invalidLogged.add(event.kind);
            this.logger.warn(
              { event: 'run_events_invalid', kind: event.kind },
              'run_events_invalid',
            );
          }
          return null;
        }
      }
      this.degrade(error);
      return null;
    }
  }

  private degrade(error: unknown): void {
    if (this.state !== 'open') return;
    this.state = 'degraded';
    this.logger.error(
      { event: 'run_events_degraded', code: errorCode(error) },
      'run_events_degraded',
    );
    const log = this.log;
    if (log !== null && !log.closed) {
      try {
        log.close();
      } catch {
        // The log already failed; its descriptor is released best-effort and
        // the degradation above is the one record of the fault.
      }
    }
  }

  private deliver(delivery: RunEventDelivery, audience: 'all' | 'committed' | 'uncommitted'): void {
    for (const subscriber of this.subscribers) {
      if (audience === 'committed' && subscriber.includeUncommitted) continue;
      if (audience === 'uncommitted' && !subscriber.includeUncommitted) continue;
      try {
        subscriber.listener(delivery);
      } catch (error) {
        if (subscriber.failureLogged) continue;
        subscriber.failureLogged = true;
        this.logger.warn(
          {
            event: 'run_events_listener_failed',
            listener_index: subscriber.index,
            error_class: error instanceof Error ? error.name : typeof error,
          },
          'run_events_listener_failed',
        );
      }
    }
  }
}

function errorCode(error: unknown): string {
  if (error instanceof RunEventLogError) return error.code;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' ? code : 'UNKNOWN';
}
