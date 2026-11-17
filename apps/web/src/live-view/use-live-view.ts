/**
 * One {@link LiveViewStore} per run view (FEAT-069): created for the run,
 * started while mounted, stopped (and the host told) on unmount.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { useRpc } from '../host/app-rpc.js';
import { connectionStore } from '../host/connection-store.js';

import {
  LiveViewStore,
  type LiveViewFrameSample,
  type LiveViewSnapshot,
} from './live-view-store.js';

export interface UseLiveView {
  readonly snapshot: LiveViewSnapshot;
  readonly attachCanvas: LiveViewStore['attachCanvas'];
}

/** Watches `runId`'s live view in this window; `onSample` feeds the budget monitor. */
export function useLiveView(
  runId: string,
  onSample?: (sample: LiveViewFrameSample) => void,
): UseLiveView {
  const rpc = useRpc();
  // The store is created once; it must call the latest sample handler.
  const sampleRef = useRef(onSample);
  sampleRef.current = onSample;
  const [store] = useState(
    () =>
      new LiveViewStore({
        rpc,
        runId,
        connection: connectionStore,
        onSample: (sample) => sampleRef.current?.(sample),
      }),
  );
  useEffect(() => {
    store.start();
    return () => {
      store.stop();
    };
  }, [store]);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return { snapshot, attachCanvas: store.attachCanvas };
}
