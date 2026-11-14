/**
 * A once-per-second clock for elapsed times (FEAT-067 TASK-003), injected so
 * tests step it instead of waiting on the wall clock (memory -> Testing).
 */

import { createContext, useCallback, useContext, useSyncExternalStore } from 'react';

/** Wall time plus a once-per-second tick. */
export interface TickClock {
  /** Milliseconds since the epoch. */
  now(): number;
  /** Calls `listener` once per second; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

/** The system clock, ticking with one shared interval while anything listens. */
export function createSystemTickClock(): TickClock {
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setInterval> | null = null;
  return {
    now: () => Date.now(),
    subscribe(listener) {
      listeners.add(listener);
      timer ??= setInterval(() => {
        for (const item of [...listeners]) item();
      }, 1_000);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && timer !== null) {
          clearInterval(timer);
          timer = null;
        }
      };
    },
  };
}

const TickClockContext = createContext<TickClock | null>(null);

/** Provides a clock (tests provide a stepped one). */
export const TickClockProvider = TickClockContext.Provider;

let fallback: TickClock | null = null;

/** The provided clock, or one system clock created on first use. */
export function useTickClock(): TickClock {
  const provided = useContext(TickClockContext);
  if (provided !== null) return provided;
  fallback ??= createSystemTickClock();
  return fallback;
}

/** Elapsed milliseconds from `startedAt` to `endedAt`, or to now while the run is live. */
export function elapsedMs(startedAt: string, endedAt: string | null, now: number): number {
  const start = Date.parse(startedAt);
  const end = endedAt === null ? now : Date.parse(endedAt);
  return Number.isNaN(start) || Number.isNaN(end) ? 0 : Math.max(0, end - start);
}

/**
 * Elapsed milliseconds, re-rendering once per second while the run is live
 * and frozen once it has ended.
 */
export function useElapsed(startedAt: string | null, endedAt: string | null): number | null {
  const clock = useTickClock();
  const live = startedAt !== null && endedAt === null;
  const subscribe = useCallback(
    (listener: () => void) => (live ? clock.subscribe(listener) : noSubscribe()),
    [clock, live],
  );
  const now = useSyncExternalStore(
    subscribe,
    () => (live ? Math.floor(clock.now() / 1_000) * 1_000 : 0),
    () => 0,
  );
  return startedAt === null ? null : elapsedMs(startedAt, endedAt, now);
}

function noSubscribe(): () => void {
  return () => undefined;
}

/** `1h 02m 05s`, `2m 05s` or `5s`. */
export function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1_000);
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = total % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  if (hours > 0) return `${String(hours)}h ${pad(minutes)}m ${pad(seconds)}s`;
  if (minutes > 0) return `${String(minutes)}m ${pad(seconds)}s`;
  return `${String(seconds)}s`;
}
