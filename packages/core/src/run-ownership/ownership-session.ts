import { join } from 'node:path';

import type { ExecutionClass, RunLease, RunLeaseOrigin, RunSocketAddress } from '@yantra/protocol';

import type { ProcessIdentity, ProcessLivenessProbe } from '../browser/installation-types.js';
import type { Logger } from '../browser/types.js';
import { streamEventSource, type RunEventSource } from '../run-channel/event-source.js';
import { startRunChannelServer, type ChannelHandler } from '../run-channel/server.js';
import { RUN_EVENTS_FILENAME } from '../run-events/log.js';
import { scanRunEventsTail } from '../run-events/reader.js';
import type { RunEventStream } from '../run-events/stream.js';

import {
  FileBrowserOwnershipRecorder,
  type BrowserOwnershipRecorder,
} from './browser-ownership-recorder.js';
import { FINISH_DRAIN_MS } from './constants.js';
import {
  claimLease,
  generateRunToken,
  releaseLease,
  type LeaseClaimDeps,
  type LeaseClaimInit,
} from './lease-store.js';

/** The run socket as the session sees it: an address to publish and a way to close it. */
export interface RunChannelEndpoint {
  readonly address: RunSocketAddress;
  /**
   * Stops accepting, ends every connection, waits up to `drainMs` for them to
   * close, then destroys any left (spike S2, RC3). Idempotent.
   */
  close(drainMs: number): Promise<void>;
  /** Serves a client message type (the real server; fakes may omit it). */
  register?(type: string, capability: string | null, handler: ChannelHandler): void;
  /** Feeds the run's committed events to subscribers (the real server). */
  attachEvents?(source: RunEventSource): void;
}

/** Starts the run socket, listening, before the lease that names it is claimed. */
export type StartRunChannel = (options: {
  readonly runId: string;
  readonly runDir: string;
  readonly token: string;
  readonly logger: Logger;
}) => Promise<RunChannelEndpoint>;

/** Claims the lease; takeover (resume) substitutes its own. */
export type ClaimRunLease = (
  runDir: string,
  init: LeaseClaimInit,
  deps: LeaseClaimDeps,
) => Promise<RunLease>;

export interface RunOwnershipSessionOptions {
  readonly runDir: string;
  readonly runId: string;
  readonly origin: RunLeaseOrigin;
  readonly executionClass: ExecutionClass;
  readonly command: readonly string[];
  readonly logger?: Logger;
  /** Starts the run socket; defaults to the real `RunChannelServer`. */
  readonly startChannel?: StartRunChannel;
  readonly claim?: ClaimRunLease;
  readonly identity?: ProcessIdentity;
  readonly probe?: ProcessLivenessProbe;
  readonly clock?: () => Date;
  readonly recorder?: BrowserOwnershipRecorder;
  readonly drainMs?: number;
}

const noopLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

/**
 * One ownership epoch of a run: the lease, the run socket that the lease
 * names, and the recorder for browsers the run spawns.
 */
export class RunOwnershipSession {
  private finishing: Promise<void> | null = null;
  private abortRun: (() => void) | null = null;
  private cancelRequested = false;

  private constructor(
    public readonly runDir: string,
    public readonly lease: RunLease,
    public readonly recorder: BrowserOwnershipRecorder,
    public readonly channel: RunChannelEndpoint,
    private readonly logger: Logger,
    private readonly drainMs: number,
  ) {
    channel.register?.('cancel', 'cancel', (_request, connection) => {
      const alreadyCancelling = this.cancelRequested;
      this.cancelRequested = true;
      const honored = this.abortRun !== null;
      connection.send({ type: 'cancel_ack', already_cancelling: alreadyCancelling, honored });
      if (!alreadyCancelling) {
        this.logger.info({ event: 'run_cancel_requested', honored }, 'run_cancel_requested');
        this.abortRun?.();
      }
    });
  }

  /**
   * Feeds the run's event stream to the run socket once the stream is open,
   * so subscribers replay its file and then follow it live.
   */
  public attachEvents(stream: RunEventStream): void {
    this.channel.attachEvents?.(streamEventSource(stream, this.runDir));
  }

  /**
   * Declares that this run honors cancellation: a `cancel` from the run socket
   * calls `abort` (the same abort a terminal interrupt triggers) and is
   * acknowledged `honored: true`. Runs that never call this acknowledge
   * `honored: false` and keep running.
   */
  public onCancel(abort: () => void): void {
    this.abortRun = abort;
  }

  /** True once any client asked to cancel. */
  public get cancelled(): boolean {
    return this.cancelRequested;
  }

  /**
   * Starts the run socket, then claims the lease naming it, with
   * `log_seq_at_claim` read from the run's event log tail.
   *
   * @throws RunLeaseHeldError when another owner holds the run; the socket is
   *   closed again before it rethrows.
   */
  public static async open(options: RunOwnershipSessionOptions): Promise<RunOwnershipSession> {
    const logger = options.logger ?? noopLogger;
    const startChannel = options.startChannel ?? startRunChannelServer;
    const token = generateRunToken();
    const channel = await startChannel({
      runId: options.runId,
      runDir: options.runDir,
      token,
      logger,
    });
    let lease: RunLease;
    try {
      const logSeqAtClaim = scanRunEventsTail(join(options.runDir, RUN_EVENTS_FILENAME)).lastSeq;
      lease = await (options.claim ?? claimLease)(
        options.runDir,
        {
          runId: options.runId,
          origin: options.origin,
          executionClass: options.executionClass,
          command: options.command,
          socket: channel.address,
          runToken: token,
          logSeqAtClaim,
        },
        {
          ...(options.identity === undefined ? {} : { identity: options.identity }),
          ...(options.probe === undefined ? {} : { probe: options.probe }),
          ...(options.clock === undefined ? {} : { clock: options.clock }),
        },
      );
    } catch (error) {
      await channel.close(0).catch(() => undefined);
      throw error;
    }
    return new RunOwnershipSession(
      options.runDir,
      lease,
      options.recorder ?? new FileBrowserOwnershipRecorder(options.runDir, options.clock),
      channel,
      logger,
      options.drainMs ?? FINISH_DRAIN_MS,
    );
  }

  /** The run's ID, as claimed. */
  public get runId(): string {
    return this.lease.run_id;
  }

  /**
   * Ends ownership: closes the run socket (draining connections so the
   * terminal event reaches attached clients), then releases the lease.
   * The caller has already flushed the terminal event and manifest. A lease
   * release failure is logged, never thrown: the run's evidence is complete,
   * and a later reconcile removes a lease whose owner is gone. Idempotent.
   */
  public finish(): Promise<void> {
    this.finishing ??= this.doFinish();
    return this.finishing;
  }

  private async doFinish(): Promise<void> {
    await this.channel.close(this.drainMs).catch((error: unknown) => {
      this.logger.warn(
        { event: 'run_channel_close_failed', error_class: errorClass(error) },
        'run_channel_close_failed',
      );
    });
    try {
      const result = await releaseLease(this.runDir, { evidenceFlushed: true });
      if (!result.released) {
        this.logger.warn(
          { event: 'run_lease_retained', owned_browsers: result.retainedBrowsers },
          'run_lease_retained',
        );
      }
    } catch (error) {
      this.logger.warn(
        { event: 'run_lease_release_failed', error_class: errorClass(error) },
        'run_lease_release_failed',
      );
    }
  }
}

function errorClass(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
