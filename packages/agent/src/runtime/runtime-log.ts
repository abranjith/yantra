/**
 * The agentic run's operator diagnostic log (`<runDir>/runtime.jsonl`).
 *
 * This is the fourth run artifact, and it is deliberately the only one the
 * model never sees. `tool-calls.jsonl` carries the stable sanitized tool
 * lifecycle, `events.jsonl` the task lifecycle, and `manifest.json` the
 * provider/session provenance; none of them answers "which browser actually
 * ran, and why was that pairing accepted?" — because that is component
 * telemetry, not a tool call or a task step. Before this existed the run's
 * components logged into a no-op, so the answer was simply unavailable after
 * the fact.
 *
 * One run owns exactly one destination. The orchestrator creates it after the
 * run directory exists, hands its logger to every browser-capable component,
 * and closes it once — after browser teardown, before `report.md` is built —
 * so terminal lifecycle events persist and no handle outlives the run.
 */

import { join } from 'node:path';

import type { Logger } from '@yantra/core';
import pino, { type DestinationStream } from 'pino';

/** The file name every agentic run writes its runtime log to. */
export const RUNTIME_LOG_FILENAME = 'runtime.jsonl';

/**
 * Middleware-only evidence that a tool threw something nothing mapped.
 *
 * The model still receives the existing generic `TOOL_EXECUTION_FAILED`
 * result; this is the operator's half of that same event, and it exists so an
 * unexpected site fault is *distinguishable* from an expected browser startup
 * refusal without either one leaking page data.
 *
 * Documentation of the shape the middleware emits; it writes the object
 * literal directly, because an interface has no implicit index signature and
 * a {@link Logger} method takes `Record<string, unknown>`.
 */
export interface ToolUnexpectedFailureRuntimeEvent {
  readonly schema_version: 1;
  readonly event: 'tool_unexpected_failure';
  readonly tool: string;
  readonly operation_phase: 'domain';
  readonly error_class: string;
}

/** What a {@link RunRuntimeLog} needs; every field has a production default. */
export interface RunRuntimeLogOptions {
  readonly runId: string;
  readonly runDir: string;
  /**
   * External boundary: the byte sink. Tests inject a memory stream; production
   * gets an async `pino.destination` on `<runDir>/runtime.jsonl`.
   */
  readonly destination?: DestinationStream;
  readonly level?: string;
}

/** A destination that can be flushed and ended — SonicBoom's surface. */
interface ClosableDestination extends DestinationStream {
  flushSync?: () => void;
  end?: () => void;
  once?: (event: string, listener: () => void) => unknown;
  on?: (event: string, listener: (error?: unknown) => void) => unknown;
  destroyed?: boolean;
}

/**
 * Owns one run-scoped Pino destination and the logger bound to it.
 *
 * `close()` is the whole reason this is a class rather than a factory: the
 * destination is asynchronous, so a run that ends without flushing loses the
 * teardown lines that explain why it ended. Close is idempotent and resolves
 * only once the underlying handle is actually closed.
 */
export class RunRuntimeLog {
  /** The path this log writes to. Useful for artifact assertions. */
  public readonly path: string;

  /** The run-bound logger handed to every component in this run. */
  public readonly logger: Logger;

  private readonly destination: ClosableDestination;
  private closing: Promise<void> | null = null;
  private closed = false;

  private constructor(path: string, destination: ClosableDestination, bound: pino.Logger) {
    this.path = path;
    this.destination = destination;
    // Writes after close are dropped, not buffered and not reopened. A run's
    // log is closed exactly once at teardown; a component that logs later is
    // logging about a run that no longer exists, and reopening the file to
    // record that would leave a handle behind for nobody to close.
    const guard =
      (write: (obj: Record<string, unknown>, msg?: string) => void) =>
      (obj: Record<string, unknown> | string, msg?: string): void => {
        if (this.closed) return;
        if (typeof obj === 'string') write({}, obj);
        else write(obj, msg);
      };
    this.logger = {
      info: guard((obj, msg) => bound.info(obj, msg)),
      warn: guard((obj, msg) => bound.warn(obj, msg)),
      error: guard((obj, msg) => bound.error(obj, msg)),
      debug: guard((obj, msg) => bound.debug(obj, msg)),
    };
  }

  /**
   * Opens the run's log. Creates the destination immediately, so a caller that
   * fails afterwards has something concrete to close.
   */
  public static open(options: RunRuntimeLogOptions): RunRuntimeLog {
    const path = join(options.runDir, RUNTIME_LOG_FILENAME);
    const destination =
      options.destination ??
      pino.destination({ dest: path, sync: false, append: true, mkdir: true });
    const bound = pino(
      { level: options.level ?? process.env.LOG_LEVEL ?? 'info' },
      destination,
    ).child({ run_id: options.runId });
    return new RunRuntimeLog(path, destination, bound);
  }

  /** True once {@link close} has been called. Exposed for lifecycle assertions. */
  public isClosed(): boolean {
    return this.closed;
  }

  /**
   * Flushes and ends the destination. Idempotent; concurrent callers share the
   * same in-flight promise and all resolve when the handle is actually closed.
   */
  public close(): Promise<void> {
    this.closing ??= this.shutdown();
    return this.closing;
  }

  private async shutdown(): Promise<void> {
    // Set before flushing: a component logging from a teardown hook must not
    // append after the final flush and lose its line to the closed handle.
    this.closed = true;
    const destination = this.destination;
    try {
      destination.flushSync?.();
    } catch {
      // A destination that cannot flush is still ended below; losing buffered
      // diagnostics must never fail a run that otherwise completed.
    }
    if (typeof destination.end !== 'function') return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      destination.once?.('close', finish);
      destination.once?.('finish', finish);
      destination.once?.('error', finish);
      destination.end!();
      // A destination with no event surface (a plain writable in a test double)
      // is already done once `end()` returns.
      if (typeof destination.once !== 'function') finish();
    });
  }
}
