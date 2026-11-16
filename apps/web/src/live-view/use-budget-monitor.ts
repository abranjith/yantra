/**
 * Automatic Solid for the cockpit (FEAT-069 TASK-011): watches the live
 * view's budget and, when it is exceeded, switches the cockpit subtree to
 * Solid for the rest of this run view. The `ui.surfaces` preference is never
 * written; a Solid preference or reduced transparency turns the monitor off.
 */

import { useEffect, useRef, useState } from 'react';

import { BudgetMonitor, solidAlready } from './budget-monitor.js';
import type { LiveViewFrameSample } from './live-view-store.js';

/** How often quiet time is accounted for. */
const TICK_MS = 1_000;

export interface UseBudgetMonitor {
  /** `solid` once the budget was exceeded in this run view. */
  readonly surfaces: 'solid' | undefined;
  /** Stable: feed it the store's frame samples. */
  readonly onSample: (sample: LiveViewFrameSample) => void;
}

interface LongAnimationFrameScript {
  readonly invokerType?: string;
  readonly invoker?: string;
  readonly duration: number;
}

/** See the module comment. */
export function useBudgetMonitor(): UseBudgetMonitor {
  const [solid, setSolid] = useState(false);
  const monitor = useRef<BudgetMonitor | null>(null);
  monitor.current ??= new BudgetMonitor({
    disabled:
      typeof document === 'undefined'
        ? true
        : solidAlready(
            document.documentElement,
            typeof window.matchMedia === 'function' ? window.matchMedia.bind(window) : undefined,
          ),
    onOverBudget: () => {
      setSolid(true);
    },
  });
  const [onSample] = useState(() => (sample: LiveViewFrameSample): void => {
    if (sample.kind === 'offered') monitor.current?.frameOffered(sample.busyMs);
    else monitor.current?.frameDrawn(sample.busyMs);
  });

  useEffect(() => {
    const timer = window.setInterval(() => monitor.current?.tick(), TICK_MS);
    let observer: PerformanceObserver | null = null;
    const supported =
      typeof PerformanceObserver !== 'undefined' &&
      PerformanceObserver.supportedEntryTypes.includes('long-animation-frame');
    if (supported) {
      // Only message handling counts: that is where frames arrive and draw.
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const scripts = (entry as unknown as { scripts?: LongAnimationFrameScript[] }).scripts;
          for (const script of scripts ?? []) {
            if (
              script.invokerType === 'event-listener' &&
              /WebSocket|message/u.test(script.invoker ?? '')
            ) {
              monitor.current?.addBusy(script.duration);
            }
          }
        }
      });
      observer.observe({ type: 'long-animation-frame', buffered: false });
    }
    return () => {
      window.clearInterval(timer);
      observer?.disconnect();
    };
  }, []);

  return { surfaces: solid ? 'solid' : undefined, onSample };
}
