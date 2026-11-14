/**
 * Follows one run's event stream from the host (FEAT-067 TASK-001): an
 * external store for `useSyncExternalStore`, created per route.
 *
 * - `start()` sends `run.subscribe {run_id, from_seq: lastSeq + 1}`; the host
 *   relay replays `run-events.jsonl` and then goes live (FEAT-065).
 * - Events are buffered and applied once per animation frame, so a replay of
 *   thousands of events renders once per frame.
 * - A gap (an event above `lastSeq + 1`) or a reconnect of the host socket
 *   resubscribes from `lastSeq + 1`; duplicates are dropped by the reducer.
 *   So a reload or a dropped connection yields exactly the uninterrupted
 *   replay (no gaps, no duplicates).
 * - `run.channel` notifications track the worker's channel: not responding
 *   after 30 s of silence, and live view unavailable for an incompatible
 *   worker (plan D17).
 *
 * The RPC handle and the connection store are injected; there are no
 * module-level singletons here.
 */

import type { AppRpc } from '../../host/app-rpc.js';
import type { ConnectionState } from '../../host/connection-store.js';

import {
  initialCockpitState,
  reduceRunEvents,
  type CockpitMode,
  type CockpitState,
  type SeqEvent,
} from './cockpit-state.js';

/** How the worker's live channel stands. */
export type ChannelStatus =
  /** Subscribed: replay then live. */
  | { readonly state: 'live' }
  /** Subscribing (or resubscribing) right now. */
  | { readonly state: 'connecting' }
  /** The run has no live owner; served from its file. */
  | { readonly state: 'replay_only' }
  /** The worker has sent nothing for 30 s. */
  | { readonly state: 'not_responding' }
  /** The worker speaks another channel version; the run continues (D17). */
  | { readonly state: 'unavailable'; readonly startedByVersion: string | null };

/** What the cockpit renders from. */
export interface RunStreamSnapshot {
  readonly cockpit: CockpitState;
  readonly channel: ChannelStatus;
  /** The last subscribe failed (e.g. no such run); the store keeps retrying on reconnect. */
  readonly error: string | null;
}

/** Frame scheduling and time, injected so tests step them. */
export interface StreamClock {
  /** Schedules `callback` for the next frame; returns a cancel function. */
  frame(callback: () => void): () => void;
}

/** The connection store slice the stream watches for reconnects. */
export interface ConnectionSource {
  subscribe(listener: () => void): () => void;
  getSnapshot(): ConnectionState;
}

export interface RunStreamDeps {
  readonly rpc: AppRpc;
  readonly runId: string;
  readonly mode?: CockpitMode;
  readonly connection?: ConnectionSource;
  readonly clock?: StreamClock;
}

/** The browser clock: one `requestAnimationFrame` per batch. */
export const BROWSER_CLOCK: StreamClock = {
  frame(callback) {
    if (typeof requestAnimationFrame === 'function') {
      const handle = requestAnimationFrame(() => {
        callback();
      });
      return () => {
        cancelAnimationFrame(handle);
      };
    }
    const handle = setTimeout(callback, 16);
    return () => {
      clearTimeout(handle);
    };
  },
};

/** A followed run; see the module comment. */
export interface RunStream {
  readonly runId: string;
  /** Closures over the store: safe to pass unbound to `useSyncExternalStore`. */
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => RunStreamSnapshot;
  /** Starts following (idempotent; restartable after `stop`). */
  start(): void;
  /** Stops following; the state is kept so a restart resumes from it. */
  stop(): void;
  /** Resubscribes from `lastSeq + 1` now (the "Retry now" action). */
  resubscribe(): void;
}

function channelOf(result: unknown): ChannelStatus {
  const channel = (result as { channel?: unknown } | null)?.channel;
  if (channel === 'replay_only') return { state: 'replay_only' };
  if (channel === 'live_unavailable') return { state: 'unavailable', startedByVersion: null };
  return { state: 'live' };
}

/** Creates the store for one run; see {@link RunStream}. */
export function createRunStream(deps: RunStreamDeps): RunStream {
  const clock = deps.clock ?? BROWSER_CLOCK;
  const listeners = new Set<() => void>();
  let snapshot: RunStreamSnapshot = {
    cockpit: initialCockpitState(deps.runId, deps.mode),
    channel: { state: 'connecting' },
    error: null,
  };
  let queue: SeqEvent[] = [];
  let cancelFrame: (() => void) | null = null;
  let running = false;
  let disposers: (() => void)[] = [];
  let wasConnected: boolean | null = null;
  /** Bumped on every subscribe, so a late answer to an older one is ignored. */
  let generation = 0;

  const emit = (): void => {
    for (const listener of [...listeners]) listener();
  };

  const set = (next: Partial<RunStreamSnapshot>): void => {
    snapshot = { ...snapshot, ...next };
    emit();
  };

  const subscribeFrom = (): void => {
    if (!running) return;
    generation += 1;
    const mine = generation;
    const fromSeq = snapshot.cockpit.lastSeq + 1;
    if (snapshot.channel.state !== 'unavailable') set({ channel: { state: 'connecting' } });
    deps.rpc.request('run.subscribe', { run_id: deps.runId, from_seq: fromSeq }).then(
      (result) => {
        if (mine !== generation || !running) return;
        const channel = channelOf(result);
        // An unavailable notice that arrived first carries the worker version; keep it.
        if (channel.state === 'unavailable' && snapshot.channel.state === 'unavailable') {
          set({ error: null });
          return;
        }
        set({ channel, error: null });
      },
      (error: unknown) => {
        if (mine !== generation || !running) return;
        set({ error: error instanceof Error ? error.message : 'The run could not be followed.' });
      },
    );
  };

  const flush = (): void => {
    cancelFrame = null;
    const batch = queue;
    queue = [];
    if (batch.length === 0) return;
    batch.sort((a, b) => a.seq - b.seq);
    const result = reduceRunEvents(snapshot.cockpit, batch);
    if (result.state !== snapshot.cockpit) snapshot = { ...snapshot, cockpit: result.state };
    emit();
    if (result.gap) subscribeFrom();
  };

  const enqueue = (item: SeqEvent): void => {
    queue.push(item);
    cancelFrame ??= clock.frame(flush);
  };

  const onEvent = (params: Record<string, unknown>): void => {
    if (params.run_id !== deps.runId || typeof params.seq !== 'number') return;
    enqueue({ seq: params.seq, event: params.event });
  };

  const onChannel = (params: Record<string, unknown>): void => {
    if (params.run_id !== deps.runId) return;
    switch (params.state) {
      case 'not_responding':
        set({ channel: { state: 'not_responding' } });
        return;
      case 'recovered':
        set({ channel: { state: 'live' } });
        return;
      case 'live_unavailable':
        set({
          channel: {
            state: 'unavailable',
            startedByVersion:
              typeof params.worker_version === 'string' ? params.worker_version : null,
          },
        });
        return;
      default:
        return;
    }
  };

  const onConnection = (): void => {
    if (deps.connection === undefined) return;
    const connected = deps.connection.getSnapshot().status === 'connected';
    // Resubscribe only on a reconnect: the first subscribe already waits for the connection.
    if (connected && wasConnected === false) subscribeFrom();
    wasConnected = connected;
  };

  return {
    runId: deps.runId,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    start() {
      if (running) return;
      running = true;
      disposers = [deps.rpc.on('run.event', onEvent), deps.rpc.on('run.channel', onChannel)];
      if (deps.connection !== undefined) {
        wasConnected = deps.connection.getSnapshot().status === 'connected';
        disposers.push(deps.connection.subscribe(onConnection));
      }
      if (queue.length > 0) cancelFrame ??= clock.frame(flush);
      subscribeFrom();
    },
    stop() {
      if (!running) return;
      running = false;
      generation += 1;
      for (const dispose of disposers) dispose();
      disposers = [];
      cancelFrame?.();
      cancelFrame = null;
      // Events already received are kept: they are applied on the next start.
      void deps.rpc.request('run.unsubscribe', { run_id: deps.runId }).catch(() => undefined);
    },
    resubscribe() {
      subscribeFrom();
    },
  };
}
