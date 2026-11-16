/**
 * The live-view relay (FEAT-069 TASK-009): frames from a worker's run socket
 * to every app window watching that run.
 *
 * - `frames.subscribe {run_id}` (an authenticated window; the run must be
 *   attached through `run.subscribe`) registers the window and returns the
 *   current `frames.state`. `frames.unsubscribe` and window close unregister.
 * - The first window to subscribe to a run sends `frames.start` to its
 *   worker; the last to leave sends `frames.stop`.
 * - Worker frames are acked to the worker **on receipt** and placed in each
 *   window's one-slot queue (newest wins), so one slow window never throttles
 *   another.
 * - **Generation floor.** On `frames.cleared` the floor rises to its
 *   generation, every window slot below it is purged, and the message goes to
 *   every window on the JSON-RPC text lane at once. Frames below the floor are
 *   dropped, so a frame that was in flight when protection began is never
 *   shown.
 * - Frames go to a window as **binary WebSocket messages** (the protocol
 *   payload) only after it acked its previous frame (`frames.ack`) and while
 *   its socket holds under {@link WINDOW_BUFFER_LIMIT} unsent bytes, so
 *   JSON-RPC responses and events never wait behind a frame.
 * - A worker without `frames/1` (D17) yields `frames.state
 *   unavailable/incompatible_worker`.
 *
 * Frames are never written to `host.log`: it records subscribe and
 * unsubscribe with window counts only.
 */

import {
  EmptyParams,
  FRAMES_CAPABILITY,
  FramesCleared,
  FramesState,
  FramesSubscribe,
  FramesSubscribeResult,
  FramesUnsubscribe,
  FramesWindowAck,
  ScreencastFrameMeta,
  encodeFramePayload,
  type FramesState as FramesStateType,
} from '@yantra/protocol';

import { SILENT_HOST_LOGGER, type HostLogger } from './host.js';
import { RpcError, type RpcConnection, type RpcMethodRegistry } from './rpc-server.js';
import type { RelayChannel, LiveOwner } from './run-relay.js';

/** Unsent bytes a window socket may hold before the next frame waits. */
export const WINDOW_BUFFER_LIMIT = 64 * 1024;
/** How soon a frame held back by socket backpressure is retried. */
const BACKPRESSURE_RETRY_MS = 20;

/** The slice of the run relay this module needs. */
export interface LiveViewRunSource {
  owner(runId: string): { readonly channel: RelayChannel; readonly live: LiveOwner | null } | null;
}

export interface LiveViewRelayDeps {
  readonly runs: LiveViewRunSource;
  readonly logger?: HostLogger;
  readonly setTimeout?: (callback: () => void, ms: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
}

interface Window {
  readonly connection: RpcConnection;
  slot: {
    readonly generation: number;
    readonly frameSeq: number;
    readonly bytes: Uint8Array;
  } | null;
  inFlight: number | null;
  retry: unknown;
}

interface Watched {
  readonly runId: string;
  readonly windows: Map<number, Window>;
  readonly owner: LiveOwner | null;
  floor: number;
  state: FramesStateType;
  dispose: (() => void)[];
}

const stateOf = (
  state: FramesStateType['state'],
  reason: FramesStateType['reason'] = 'none',
): FramesStateType => ({ generation: 0, state, reason, page: null });

export class LiveViewRelay {
  private readonly runs = new Map<string, Watched>();
  private readonly logger: HostLogger;
  /** Frames dropped below a floor, for logs and tests (counts only). */
  public droppedBelowFloor = 0;

  public constructor(private readonly deps: LiveViewRelayDeps) {
    this.logger = deps.logger ?? SILENT_HOST_LOGGER;
  }

  /** Runs with at least one watching window. */
  public watchedRuns(): string[] {
    return [...this.runs.keys()];
  }

  public register(methods: RpcMethodRegistry): void {
    methods
      .register('frames.subscribe', {
        params: FramesSubscribe,
        result: FramesSubscribeResult,
        handler: ({ run_id: runId }, { connection }) => this.subscribe(connection, runId),
      })
      .register('frames.unsubscribe', {
        params: FramesUnsubscribe,
        result: EmptyParams,
        handler: ({ run_id: runId }, { connection }) => {
          this.unsubscribe(connection.id, runId);
          return {};
        },
      })
      .register('frames.ack', {
        params: FramesWindowAck,
        result: EmptyParams,
        handler: ({ run_id: runId, frame_seq: frameSeq }, { connection }) => {
          this.windowAck(connection.id, runId, frameSeq);
          return {};
        },
      });
  }

  /** Registers a window; returns the run's current live-view state. */
  public subscribe(connection: RpcConnection, runId: string): FramesStateType {
    const owner = this.deps.runs.owner(runId);
    if (owner === null) {
      throw new RpcError(
        'not_found',
        `Run ${runId} is not attached in this window.`,
        'Call run.subscribe for the run first.',
      );
    }
    let watched = this.runs.get(runId);
    if (watched === undefined) {
      watched = this.watch(runId, owner.channel, owner.live);
      this.runs.set(runId, watched);
    }
    if (!watched.windows.has(connection.id)) {
      watched.windows.set(connection.id, { connection, slot: null, inFlight: null, retry: null });
      connection.onClose(() => {
        this.unsubscribe(connection.id, runId);
      });
      this.logger.info({ run_id: runId, windows: watched.windows.size }, 'live view subscribed');
    }
    return watched.state;
  }

  /** Unregisters a window; the last one stops the worker's frames. */
  public unsubscribe(connectionId: number, runId: string): void {
    const watched = this.runs.get(runId);
    const window = watched?.windows.get(connectionId);
    if (watched === undefined || window === undefined) return;
    this.cancelRetry(window);
    watched.windows.delete(connectionId);
    this.logger.info({ run_id: runId, windows: watched.windows.size }, 'live view unsubscribed');
    if (watched.windows.size > 0) return;
    this.stopWatching(watched);
  }

  /** The run was detached by the run relay: its worker connection is gone. */
  public runDetached(runId: string): void {
    const watched = this.runs.get(runId);
    if (watched === undefined) return;
    for (const window of watched.windows.values()) this.cancelRetry(window);
    for (const dispose of watched.dispose) dispose();
    this.runs.delete(runId);
  }

  /** Detaches everything (host shutdown). */
  public close(): void {
    for (const runId of [...this.runs.keys()]) this.runDetached(runId);
  }

  private watch(runId: string, channel: RelayChannel, live: LiveOwner | null): Watched {
    const usable = live?.capabilities.includes(FRAMES_CAPABILITY) === true;
    const watched: Watched = {
      runId,
      windows: new Map(),
      owner: usable ? live : null,
      floor: 0,
      state:
        live === null
          ? channel === 'live_unavailable'
            ? stateOf('unavailable', 'incompatible_worker')
            : stateOf('no_page')
          : usable
            ? stateOf('no_page')
            : stateOf('unavailable', 'incompatible_worker'),
      dispose: [],
    };
    if (live === null || !usable) return watched;
    const { client } = live;
    const offMessages = client.onServerMessage?.((message) => {
      this.onWorkerMessage(watched, message);
    });
    const offFrames = client.onScreencastFrame?.((meta, jpeg) => {
      this.onWorkerFrame(watched, meta, jpeg);
    });
    if (offMessages !== undefined) watched.dispose.push(offMessages);
    if (offFrames !== undefined) watched.dispose.push(offFrames);
    client.send({ type: 'frames.start' });
    return watched;
  }

  private stopWatching(watched: Watched): void {
    watched.owner?.client.send({ type: 'frames.stop' });
    for (const dispose of watched.dispose) dispose();
    this.runs.delete(watched.runId);
  }

  private onWorkerMessage(watched: Watched, message: unknown): void {
    if (typeof message !== 'object' || message === null) return;
    const { type, ...body } = message as { readonly type?: unknown } & Record<string, unknown>;
    if (type === 'frames.cleared') {
      const cleared = FramesCleared.safeParse(body);
      if (!cleared.success) return;
      // Floor first, then purge, then tell every window — before any later frame.
      watched.floor = Math.max(watched.floor, cleared.data.generation);
      for (const window of watched.windows.values()) {
        if (window.slot !== null && window.slot.generation < watched.floor) window.slot = null;
        window.connection.notify('frames.cleared', { run_id: watched.runId, ...cleared.data });
      }
      return;
    }
    if (type === 'frames.state') {
      const state = FramesState.safeParse(body);
      if (!state.success) return;
      watched.floor = Math.max(watched.floor, state.data.generation);
      watched.state = state.data;
      for (const window of watched.windows.values()) {
        if (window.slot !== null && window.slot.generation < watched.floor) window.slot = null;
        window.connection.notify('frames.state', { run_id: watched.runId, ...state.data });
      }
    }
  }

  private onWorkerFrame(watched: Watched, rawMeta: unknown, jpeg: Uint8Array): void {
    const parsed = ScreencastFrameMeta.safeParse(rawMeta);
    if (!parsed.success) return;
    const meta = parsed.data;
    // Acked on receipt: the worker's pace never depends on any window.
    watched.owner?.client.send({
      type: 'frame.ack',
      generation: meta.generation,
      frame_seq: meta.frame_seq,
    });
    if (meta.generation < watched.floor) {
      this.droppedBelowFloor += 1;
      return;
    }
    let bytes: Uint8Array;
    try {
      bytes = encodeFramePayload(meta, jpeg);
    } catch {
      // Over the payload limit or not a JPEG: dropped, never forwarded.
      return;
    }
    for (const window of watched.windows.values()) {
      window.slot = { generation: meta.generation, frameSeq: meta.frame_seq, bytes };
      this.pump(watched, window);
    }
  }

  /** A window drew or dropped a frame (the `frames.ack` RPC). */
  public windowAck(connectionId: number, runId: string, frameSeq: number): void {
    const watched = this.runs.get(runId);
    const window = watched?.windows.get(connectionId);
    if (watched === undefined || window === undefined) return;
    if (window.inFlight === null || frameSeq < window.inFlight) return;
    window.inFlight = null;
    this.pump(watched, window);
  }

  private pump(watched: Watched, window: Window): void {
    if (window.inFlight !== null || window.slot === null) return;
    if (window.slot.generation < watched.floor) {
      window.slot = null;
      return;
    }
    const buffered = window.connection.bufferedAmount?.() ?? 0;
    if (buffered >= WINDOW_BUFFER_LIMIT) {
      // The socket is still flushing: let JSON-RPC go first, try again shortly.
      if (window.retry === null) {
        window.retry = (this.deps.setTimeout ?? setTimeout)(() => {
          window.retry = null;
          this.pump(watched, window);
        }, BACKPRESSURE_RETRY_MS);
      }
      return;
    }
    const { bytes, frameSeq } = window.slot;
    window.slot = null;
    if (window.connection.sendBinary?.(bytes) === true) window.inFlight = frameSeq;
  }

  private cancelRetry(window: Window): void {
    if (window.retry === null) return;
    (this.deps.clearTimeout ?? ((handle) => clearTimeout(handle as NodeJS.Timeout)))(window.retry);
    window.retry = null;
  }
}
