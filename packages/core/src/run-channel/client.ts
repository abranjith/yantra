/**
 * `RunChannelClient` — attaches to a run's socket from its lease (FEAT-064).
 *
 * - `connect(lease)` authenticates with the lease's token and resolves to
 *   `attached`, `live_unavailable` (an owner whose channel version this
 *   executable cannot speak — the client then never sends `cancel`), or
 *   `unreachable`.
 * - `subscribe(fromSeq)` replays from the run's log and continues live. The
 *   client dedupes by `seq`: it never delivers a `seq` at or below the last one
 *   it delivered.
 * - When the connection closes before the run's `run_outcome`, the client
 *   first reads `run-events.jsonl` from `lastSeq + 1` (spike S2, RC3): an owner
 *   that exits right after its terminal event may never send it.
 * - `reconnect()` backs off from 250 ms to 5 s, re-reads the lease (a resumed
 *   run has a new token and address) and resubscribes from `lastSeq + 1`.
 * - No frame of any kind for 30 s moves it to `not_responding`, logged once;
 *   the next frame moves it back.
 */

import { connect as netConnect, type Socket } from 'node:net';
import { join } from 'node:path';

import {
  CHANNEL_CAPABILITY_CANCEL,
  CHANNEL_CAPABILITY_EVENTS,
  CHANNEL_VERSION,
  RunChannelServerMessage,
  SUPPORTED_CHANNEL_VERSIONS,
  type RunChannelClientMessage,
  type RunChannelEventPayload,
  type RunEventReadItem,
  type RunLease,
} from '@yantra/protocol';

import type { Logger } from '../browser/types.js';
import { RUN_EVENTS_FILENAME } from '../run-events/log.js';
import { readRunEvents } from '../run-events/reader.js';
import {
  HELLO_DEADLINE_MS,
  NOT_RESPONDING_AFTER_MS,
  RECONNECT_INITIAL_MS,
  RECONNECT_MAX_MS,
} from '../run-ownership/constants.js';
import { readLease } from '../run-ownership/lease-store.js';

import { FrameDecoder, encodeJsonFrame } from './frame-codec.js';
import { realTimers, type RunChannelTimers } from './server.js';

export type RunChannelClientState =
  | 'idle'
  | 'connecting'
  | 'attached'
  | 'not_responding'
  | 'disconnected'
  | 'live_unavailable'
  | 'unreachable'
  | 'ended'
  | 'closed';

export type ChannelConnectResult =
  | {
      readonly state: 'attached';
      readonly capabilities: readonly string[];
      readonly channelVersion: number;
    }
  | { readonly state: 'live_unavailable'; readonly ownerVersion: string }
  | { readonly state: 'unreachable' };

/** One delivered event; `event` is null for an `event_oversize` placeholder. */
export interface ChannelEventDelivery {
  readonly seq: number;
  readonly event: RunChannelEventPayload | null;
  /** True when it came from `run-events.jsonl` rather than the socket. */
  readonly fromFile: boolean;
}

export interface RunChannelClientSnapshot {
  readonly state: RunChannelClientState;
  readonly lastSeq: number;
  /** The owner's Yantra version, once known. */
  readonly ownerVersion: string | null;
}

export interface CancelAck {
  readonly alreadyCancelling: boolean;
  readonly honored: boolean;
}

export interface RunChannelClientOptions {
  readonly clientKind: 'host' | 'cli' | 'test';
  /** The run directory: where the lease is re-read and the log is read on fallback. */
  readonly runDir: string;
  readonly capabilities?: readonly string[];
  readonly logger?: Logger;
  readonly timers?: RunChannelTimers;
  readonly helloTimeoutMs?: number;
  readonly notRespondingMs?: number;
  /** How many connection attempts one `reconnect()` makes before `unreachable`. */
  readonly maxReconnectAttempts?: number;
  /** Socket factory seam (tests). */
  readonly connectSocket?: (path: string) => Socket;
  /** Delay seam for reconnect backoff (tests). */
  readonly sleep?: (ms: number) => Promise<void>;
  /** The channel version this client claims to speak (tests of newer clients). */
  readonly channelVersion?: number;
}

const noopLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

type Listener<T> = (value: T) => void;

export class RunChannelClient {
  private socket: Socket | null = null;
  private decoder = new FrameDecoder();
  private state: RunChannelClientState = 'idle';
  private lastSeq = 0;
  private ownerVersion: string | null = null;
  private outcomeSeen = false;
  private snapshot: RunChannelClientSnapshot;
  private readonly eventListeners = new Set<Listener<ChannelEventDelivery>>();
  private readonly snapshotListeners = new Set<() => void>();
  private pendingHello: ((result: ChannelConnectResult) => void) | null = null;
  private pendingCancel: ((ack: CancelAck | null) => void) | null = null;
  private silenceTimer: unknown = null;
  private readonly logger: Logger;
  private readonly timers: RunChannelTimers;
  /** Seqs that arrived above `lastSeq + 1`; must stay 0 (tests assert it). */
  public gaps = 0;

  public constructor(private readonly options: RunChannelClientOptions) {
    this.logger = options.logger ?? noopLogger;
    this.timers = options.timers ?? realTimers;
    this.snapshot = { state: this.state, lastSeq: 0, ownerVersion: null };
  }

  /** A `useSyncExternalStore`-friendly snapshot: a new object only when something changed. */
  public getSnapshot = (): RunChannelClientSnapshot => this.snapshot;

  /** `useSyncExternalStore` subscribe: called on every snapshot change. */
  public subscribeSnapshot = (listener: () => void): (() => void) => {
    this.snapshotListeners.add(listener);
    return () => this.snapshotListeners.delete(listener);
  };

  /** Receives each event once, in strictly increasing `seq` order. */
  public onEvent(listener: Listener<ChannelEventDelivery>): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /**
   * Authenticates against the lease's socket. An owner whose channel version
   * is outside this client's range is `live_unavailable` without connecting.
   */
  public async connect(lease: RunLease): Promise<ChannelConnectResult> {
    this.dropSocket();
    this.ownerVersion = lease.yantra_version;
    if (lease.channel_version < SUPPORTED_CHANNEL_VERSIONS.min) {
      this.setState('live_unavailable');
      return { state: 'live_unavailable', ownerVersion: lease.yantra_version };
    }
    this.setState('connecting');
    this.decoder = new FrameDecoder();
    const socket = (this.options.connectSocket ?? netConnect)(lease.socket.address);
    this.socket = socket;
    const result = await new Promise<ChannelConnectResult>((resolve) => {
      let settled = false;
      const settle = (value: ChannelConnectResult): void => {
        if (settled) return;
        settled = true;
        this.timers.clearTimeout(deadline);
        this.pendingHello = null;
        resolve(value);
      };
      this.pendingHello = settle;
      const deadline = this.timers.setTimeout(() => {
        settle({ state: 'unreachable' });
        socket.destroy();
      }, this.options.helloTimeoutMs ?? HELLO_DEADLINE_MS);
      socket.on('error', () => {
        settle({ state: 'unreachable' });
      });
      socket.on('close', () => {
        settle({ state: 'unreachable' });
        if (this.socket === socket) this.onSocketClosed();
      });
      socket.on('data', (chunk: Buffer) => {
        if (this.socket === socket) this.onData(chunk);
      });
      socket.once('connect', () => {
        const hello: RunChannelClientMessage = {
          type: 'hello',
          token: lease.run_token,
          channel_version: this.options.channelVersion ?? CHANNEL_VERSION,
          capabilities: [
            ...(this.options.capabilities ?? [
              CHANNEL_CAPABILITY_EVENTS,
              CHANNEL_CAPABILITY_CANCEL,
            ]),
          ],
          client_kind: this.options.clientKind,
        };
        socket.write(encodeJsonFrame(hello));
      });
    });
    if (result.state === 'attached') {
      this.setState('attached');
      this.armSilence();
    } else if (result.state === 'live_unavailable') {
      this.setState('live_unavailable');
    } else if (this.state === 'connecting') {
      this.setState('unreachable');
    }
    return result;
  }

  /** Asks the owner to replay from `fromSeq` (default `lastSeq + 1`) and continue live. */
  public subscribe(fromSeq: number = this.lastSeq + 1): void {
    this.send({ type: 'subscribe', from_seq: fromSeq });
  }

  /**
   * Asks the owner to stop the run. Resolves with its acknowledgement, or null
   * when not attached or the connection closes first. Never sent to an owner
   * this client cannot speak to.
   */
  public cancel(): Promise<CancelAck | null> {
    if (!this.isAttached()) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.pendingCancel?.(null);
      this.pendingCancel = resolve;
      this.send({ type: 'cancel' });
    });
  }

  /** Sends a client message on an attached connection; dropped otherwise. */
  public send(message: RunChannelClientMessage): void {
    if (!this.isAttached() || this.socket === null) return;
    this.socket.write(encodeJsonFrame(message));
  }

  /**
   * Re-reads the lease and reattaches with backoff, then resubscribes from
   * `lastSeq + 1`. With no lease left the run is over: the log is read to its
   * end and the client reports `ended` (or `unreachable` if the log has no
   * outcome either).
   */
  public async reconnect(): Promise<ChannelConnectResult | { readonly state: 'ended' }> {
    const sleep = this.options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const attempts = this.options.maxReconnectAttempts ?? 10;
    let delay = RECONNECT_INITIAL_MS;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (this.state === 'closed') return { state: 'unreachable' };
      const read = await readLease(this.options.runDir).catch(() => ({ kind: 'corrupt' as const }));
      if (read.kind === 'absent') {
        await this.readFromFile();
        if (this.outcomeSeen) {
          this.setState('ended');
          return { state: 'ended' };
        }
      } else if (read.kind === 'lease') {
        const result = await this.connect(read.lease);
        if (result.state === 'attached') {
          this.subscribe();
          return result;
        }
        if (result.state === 'live_unavailable') return result;
      }
      if (attempt + 1 < attempts) await sleep(delay);
      delay = Math.min(delay * 2, RECONNECT_MAX_MS);
    }
    this.setState('unreachable');
    return { state: 'unreachable' };
  }

  /** Closes the connection for good. */
  public close(): void {
    this.setState('closed');
    this.dropSocket();
  }

  private isAttached(): boolean {
    return this.state === 'attached' || this.state === 'not_responding';
  }

  private dropSocket(): void {
    this.timers.clearTimeout(this.silenceTimer);
    this.silenceTimer = null;
    const socket = this.socket;
    this.socket = null;
    socket?.destroy();
  }

  private onData(chunk: Buffer): void {
    for (const frame of this.decoder.push(chunk)) {
      if (frame.kind === 'fatal') {
        this.socket?.destroy();
        return;
      }
      this.onFrameReceived();
      if (frame.kind === 'json') this.onMessage(frame.message);
    }
  }

  private onMessage(raw: unknown): void {
    const parsed = RunChannelServerMessage.safeParse(raw);
    if (!parsed.success) return;
    const message = parsed.data;
    switch (message.type) {
      case 'hello_ok': {
        const ok = message as Extract<RunChannelServerMessage, { type: 'hello_ok' }>;
        this.pendingHello?.({
          state: 'attached',
          capabilities: ok.capabilities,
          channelVersion: ok.channel_version,
        });
        return;
      }
      case 'hello_incompatible': {
        const incompatible = message as Extract<
          RunChannelServerMessage,
          { type: 'hello_incompatible' }
        >;
        this.ownerVersion = incompatible.yantra_version;
        this.pendingHello?.({
          state: 'live_unavailable',
          ownerVersion: incompatible.yantra_version,
        });
        this.socket?.destroy();
        return;
      }
      case 'event': {
        const event = message as Extract<RunChannelServerMessage, { type: 'event' }>;
        this.deliver(event.seq, event.event, false);
        return;
      }
      case 'event_oversize':
        this.deliver((message as { seq: number }).seq, null, false);
        return;
      case 'cancel_ack': {
        const ack = message as Extract<RunChannelServerMessage, { type: 'cancel_ack' }>;
        const pending = this.pendingCancel;
        this.pendingCancel = null;
        pending?.({ alreadyCancelling: ack.already_cancelling, honored: ack.honored });
        return;
      }
      case 'error':
        this.logger.debug(
          { event: 'run_channel_error', code: (message as { code: string }).code },
          'run_channel_error',
        );
        return;
      default:
        return;
    }
  }

  private deliver(seq: number, event: RunChannelEventPayload | null, fromFile: boolean): void {
    if (seq <= this.lastSeq) return;
    if (seq !== this.lastSeq + 1) {
      this.gaps += 1;
      this.logger.warn(
        { event: 'run_channel_gap', expected: this.lastSeq + 1, received: seq },
        'run_channel_gap',
      );
    }
    this.lastSeq = seq;
    if (event !== null) {
      if (event.kind === 'run_outcome') this.outcomeSeen = true;
      else if (event.kind === 'task_resumed') this.outcomeSeen = false;
    }
    const delivery: ChannelEventDelivery = { seq, event, fromFile };
    for (const listener of this.eventListeners) listener(delivery);
    this.publishSnapshot();
  }

  private onSocketClosed(): void {
    this.socket = null;
    this.timers.clearTimeout(this.silenceTimer);
    this.pendingCancel?.(null);
    this.pendingCancel = null;
    if (this.state === 'closed' || this.state === 'live_unavailable') return;
    if (this.state === 'attached' || this.state === 'not_responding') {
      this.setState('disconnected');
      // RC3: the owner may have exited before its terminal event reached us.
      if (!this.outcomeSeen) {
        void this.readFromFile().then(() => {
          if (this.outcomeSeen && this.state === 'disconnected') this.setState('ended');
        });
      } else {
        this.setState('ended');
      }
    }
  }

  /** Reads `run-events.jsonl` from `lastSeq + 1`, delivering what it holds. */
  public async readFromFile(): Promise<void> {
    const path = join(this.options.runDir, RUN_EVENTS_FILENAME);
    try {
      for await (const item of readRunEvents(path, { fromSeq: this.lastSeq + 1 })) {
        const delivered = fileDelivery(item);
        if (delivered !== null) this.deliver(delivered.seq, delivered.event, true);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.debug(
          { event: 'run_channel_file_read_failed' },
          'run_channel_file_read_failed',
        );
      }
    }
  }

  private onFrameReceived(): void {
    if (this.state === 'not_responding') {
      this.setState('attached');
      this.logger.info({ event: 'run_channel_responding' }, 'run_channel_responding');
    }
    if (this.isAttached()) this.armSilence();
  }

  private armSilence(): void {
    this.timers.clearTimeout(this.silenceTimer);
    this.silenceTimer = this.timers.setTimeout(() => {
      if (this.state !== 'attached') return;
      this.setState('not_responding');
      this.logger.warn({ event: 'run_channel_not_responding' }, 'run_channel_not_responding');
    }, this.options.notRespondingMs ?? NOT_RESPONDING_AFTER_MS);
  }

  private setState(state: RunChannelClientState): void {
    if (this.state === state) return;
    if (this.state === 'closed') return;
    this.state = state;
    this.publishSnapshot();
  }

  private publishSnapshot(): void {
    this.snapshot = { state: this.state, lastSeq: this.lastSeq, ownerVersion: this.ownerVersion };
    for (const listener of this.snapshotListeners) listener();
  }
}

function fileDelivery(
  item: RunEventReadItem,
): { readonly seq: number; readonly event: RunChannelEventPayload } | null {
  if (item.status === 'event') return { seq: item.record.seq, event: item.record.event };
  if (item.status === 'unknown_kind') {
    return { seq: item.seq, event: item.raw as RunChannelEventPayload };
  }
  return null;
}
