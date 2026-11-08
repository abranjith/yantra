/**
 * `RunEventLog` — the single writer of `<runDir>/run-events.jsonl` (FEAT-063).
 *
 * Contract (plan §8 "Event log contract"):
 *
 * - **Single writer.** Only the run's owning process appends. Until FEAT-064's
 *   lease lands, ownership is by construction: only the process that created
 *   the run directory opens the log.
 *   STUB: lease-enforced ownership arrives with FEAT-064.
 * - **Sequence.** `seq` is assigned here, never by a producer: gap-free and
 *   strictly increasing by 1 from the last valid line.
 * - **Tail recovery.** On open, a trailing partial line is truncated, and `seq`
 *   continues from the last valid record.
 * - **Synchronous append.** `append` writes with `fs.writeSync` on a descriptor
 *   opened for append, so producers keep a synchronous `emit`.
 * - **Flush points.** `fdatasync` runs immediately after an intervention or
 *   terminal event, after 50 unsynced appends, 1 second after the first
 *   unsynced append, and on `close()`.
 * - **Line cap.** A line over {@link MAX_RUN_EVENT_LINE_BYTES} is replaced by an
 *   `event_omitted` marker.
 * - **One outcome.** A second `run_outcome` is refused. A `task_resumed`
 *   (a resume continuing this run directory) begins a new execution segment,
 *   which records its own outcome.
 */

import { closeSync, fdatasyncSync, mkdirSync, openSync, truncateSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  INTERVENTION_EVENT_KINDS,
  MAX_RUN_EVENT_LINE_BYTES,
  RUN_EVENTS_SCHEMA_VERSION,
  RunEvent,
  TERMINAL_EVENT_KINDS,
  type RunEventType,
} from '@yantra/protocol';

import type { Logger } from '../browser/types.js';

import { scanRunEventsTail } from './reader.js';

/** The run-directory file every run writes. */
export const RUN_EVENTS_FILENAME = 'run-events.jsonl';
/** Unsynced appends that force a sync. Pending real-run confirmation (plan §15). */
export const RUN_EVENTS_SYNC_EVERY = 50;
/** Longest an append waits for a sync, in ms. Pending real-run confirmation (plan §15). */
export const RUN_EVENTS_SYNC_INTERVAL_MS = 1_000;

/** Stable failure codes of the run-event log. */
export type RunEventLogErrorCode =
  | 'RUN_EVENT_LOG_CLOSED'
  | 'RUN_OUTCOME_DUPLICATE'
  | 'RUN_EVENT_LOG_OPEN_FAILED'
  | 'RUN_EVENT_INVALID';

/** A typed run-event log failure; `message` never carries event payloads. */
export class RunEventLogError extends Error {
  public override readonly name = 'RunEventLogError';

  public constructor(
    public readonly code: RunEventLogErrorCode,
    message: string,
    options: { readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
  }
}

/** Timer seam for the interval sync; the default unrefs, so it never holds the process. */
export interface RunEventLogScheduler {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const defaultScheduler: RunEventLogScheduler = {
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    handle.unref();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Options for {@link RunEventLog.open}. */
export interface RunEventLogOptions {
  readonly runDir: string;
  readonly runId: string;
  /** Durability barrier; defaults to `fs.fdatasyncSync`. */
  readonly sync?: (fd: number) => void;
  /** Interval-sync timer; defaults to an unref'd `setTimeout`. */
  readonly scheduler?: RunEventLogScheduler;
  readonly logger?: Logger;
}

const FORCE_SYNC: ReadonlySet<string> = new Set<string>([
  ...INTERVENTION_EVENT_KINDS,
  ...TERMINAL_EVENT_KINDS,
]);

export class RunEventLog {
  /** Absolute path of the log file. */
  public readonly path: string;
  private fd: number | null;
  private nextSeq: number;
  private outcomeWritten: boolean;
  private unsynced = 0;
  private timer: unknown = null;
  private syncFailureLogged = false;

  private constructor(
    private readonly runId: string,
    path: string,
    fd: number,
    tail: { readonly lastSeq: number; readonly lastKind: string | null },
    private readonly sync: (fd: number) => void,
    private readonly scheduler: RunEventLogScheduler,
    private readonly logger: Logger | undefined,
  ) {
    this.path = path;
    this.fd = fd;
    this.nextSeq = tail.lastSeq + 1;
    this.outcomeWritten = tail.lastKind === 'run_outcome';
  }

  /**
   * Opens (or creates) a run's log for appending, recovering the tail first.
   *
   * @throws {RunEventLogError} `RUN_EVENT_LOG_OPEN_FAILED` when the file cannot
   *   be scanned, truncated or opened.
   */
  public static open(options: RunEventLogOptions): RunEventLog {
    const path = join(options.runDir, RUN_EVENTS_FILENAME);
    try {
      mkdirSync(dirname(path), { recursive: true });
      const tail = scanRunEventsTail(path);
      if (tail.partialTail) truncateSync(path, tail.validBytes);
      const fd = openSync(path, 'a', 0o600);
      return new RunEventLog(
        options.runId,
        path,
        fd,
        tail,
        options.sync ?? fdatasyncSync,
        options.scheduler ?? defaultScheduler,
        options.logger,
      );
    } catch (error) {
      throw new RunEventLogError(
        'RUN_EVENT_LOG_OPEN_FAILED',
        `Could not open ${RUN_EVENTS_FILENAME}: ${(error as NodeJS.ErrnoException).code ?? 'error'}`,
        { cause: error },
      );
    }
  }

  /** The `seq` the next append will receive. */
  public get nextSequence(): number {
    return this.nextSeq;
  }

  /** Whether the log is closed. */
  public get closed(): boolean {
    return this.fd === null;
  }

  /**
   * Validates, serializes and appends one event; returns its `seq`. The stored
   * record is the schema's parse of the event, so unknown keys never reach the
   * file.
   *
   * @throws {RunEventLogError} `RUN_EVENT_LOG_CLOSED` after close,
   *   `RUN_OUTCOME_DUPLICATE` for a second `run_outcome`, `RUN_EVENT_INVALID`
   *   for an event the schema rejects. A failed write rethrows the system error.
   */
  public append(event: RunEventType): number {
    if (this.fd === null) {
      throw new RunEventLogError('RUN_EVENT_LOG_CLOSED', 'The run-event log is closed.');
    }
    if (event.kind === 'run_outcome' && this.outcomeWritten) {
      throw new RunEventLogError(
        'RUN_OUTCOME_DUPLICATE',
        'This run already recorded its run_outcome.',
      );
    }
    const parsed = RunEvent.safeParse(event);
    if (!parsed.success) {
      throw new RunEventLogError(
        'RUN_EVENT_INVALID',
        `A ${String((event as { kind?: unknown }).kind)} event failed validation at ${parsed.error.issues[0]?.path.join('.') ?? '?'}.`,
      );
    }
    const seq = this.nextSeq;
    const line = this.serialize(seq, parsed.data);
    writeFully(this.fd, line);
    this.nextSeq = seq + 1;
    if (event.kind === 'run_outcome') this.outcomeWritten = true;
    // A resume continues the same run directory and log: it starts a new
    // execution segment, which ends in its own run_outcome.
    else if (event.kind === 'task_resumed') this.outcomeWritten = false;
    this.unsynced += 1;
    if (FORCE_SYNC.has(event.kind) || this.unsynced >= RUN_EVENTS_SYNC_EVERY) this.syncNow();
    else this.armTimer();
    return seq;
  }

  /** Syncs any unsynced appends now. */
  public flush(): void {
    if (this.fd !== null && this.unsynced > 0) this.syncNow();
  }

  /** Syncs and closes; idempotent. */
  public close(): void {
    if (this.fd === null) return;
    this.clearTimer();
    try {
      this.sync(this.fd);
      this.unsynced = 0;
    } finally {
      closeSync(this.fd);
      this.fd = null;
    }
  }

  private serialize(seq: number, event: unknown): string {
    const line = `${JSON.stringify({
      schema_version: RUN_EVENTS_SCHEMA_VERSION,
      seq,
      run_id: this.runId,
      event,
    })}\n`;
    const bytes = Buffer.byteLength(line, 'utf8');
    if (bytes <= MAX_RUN_EVENT_LINE_BYTES) return line;
    const original = event as { readonly kind: string; readonly at: string };
    return `${JSON.stringify({
      schema_version: RUN_EVENTS_SCHEMA_VERSION,
      seq,
      run_id: this.runId,
      event: {
        kind: 'event_omitted',
        original_kind: original.kind.slice(0, 64),
        bytes,
        at: original.at,
      },
    })}\n`;
  }

  private syncNow(): void {
    this.clearTimer();
    if (this.fd === null) return;
    this.sync(this.fd);
    this.unsynced = 0;
  }

  private armTimer(): void {
    if (this.timer !== null) return;
    this.timer = this.scheduler.setTimeout(() => {
      this.timer = null;
      try {
        if (this.unsynced > 0) this.syncNow();
      } catch (error) {
        // An interval sync failing is not an append failure: the bytes were
        // written; only durability is in doubt. Logged once, retried on the
        // next flush point.
        if (!this.syncFailureLogged) {
          this.syncFailureLogged = true;
          this.logger?.error(
            {
              event: 'run_events_sync_failed',
              code: (error as NodeJS.ErrnoException).code ?? null,
            },
            'run_events_sync_failed',
          );
        }
      }
    }, RUN_EVENTS_SYNC_INTERVAL_MS);
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    this.scheduler.clearTimeout(this.timer);
    this.timer = null;
  }
}

/** `writeSync` may write fewer bytes than asked; finish the line or throw. */
function writeFully(fd: number, line: string): void {
  const buffer = Buffer.from(line, 'utf8');
  let offset = 0;
  while (offset < buffer.length) {
    offset += writeSync(fd, buffer, offset, buffer.length - offset);
  }
}
