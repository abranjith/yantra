/**
 * React hooks over a {@link RunStream} (FEAT-067 TASK-001).
 *
 * The store is created once per mounted route (one per run ID) and follows
 * the run while mounted; there is no global store. The RPC handle comes from
 * context, the connection store from the shell.
 */

import { useEffect, useState, useSyncExternalStore } from 'react';

import { useRpc } from '../../host/app-rpc.js';
import { connectionStore } from '../../host/connection-store.js';

import type { CockpitMode, CockpitState } from './cockpit-state.js';
import {
  createRunStream,
  type ConnectionSource,
  type RunStream,
  type RunStreamSnapshot,
  type StreamClock,
} from './run-stream.js';

export interface UseRunStreamOptions {
  readonly mode?: CockpitMode;
  readonly connection?: ConnectionSource;
  readonly clock?: StreamClock;
}

/** Creates and follows the store for `runId` while the calling component is mounted. */
export function useRunStream(runId: string, options: UseRunStreamOptions = {}): RunStream {
  const rpc = useRpc();
  const [stream, setStream] = useState<RunStream>(() =>
    createRunStream({
      rpc,
      runId,
      connection: options.connection ?? connectionStore,
      ...(options.mode === undefined ? {} : { mode: options.mode }),
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    }),
  );
  // A different run in the same mounted route gets its own store.
  if (stream.runId !== runId) {
    const next = createRunStream({
      rpc,
      runId,
      connection: options.connection ?? connectionStore,
      ...(options.mode === undefined ? {} : { mode: options.mode }),
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    });
    setStream(next);
  }
  useEffect(() => {
    stream.start();
    return () => {
      stream.stop();
    };
  }, [stream]);
  return stream;
}

/** The whole snapshot of `stream`. */
export function useRunSnapshot(stream: RunStream): RunStreamSnapshot {
  return useSyncExternalStore(stream.subscribe, stream.getSnapshot, stream.getSnapshot);
}

/**
 * One slice of the cockpit state. `select` must return a value that is
 * stable while the state is unchanged (a field, not a fresh object).
 */
export function useCockpit<T>(stream: RunStream, select: (state: CockpitState) => T): T {
  const read = (): T => select(stream.getSnapshot().cockpit);
  return useSyncExternalStore(stream.subscribe, read, read);
}
