/**
 * The user's reduced-motion preference as a React hook (FEAT-067).
 *
 * The stylesheet already stops every animation under
 * `prefers-reduced-motion: reduce`; components that would loop also leave the
 * animation class off entirely, so nothing even starts.
 */

import { useSyncExternalStore } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

function media(): MediaQueryList | null {
  return typeof window === 'undefined' || typeof window.matchMedia !== 'function'
    ? null
    : window.matchMedia(QUERY);
}

function subscribe(listener: () => void): () => void {
  const list = media();
  if (list === null) return () => undefined;
  list.addEventListener('change', listener);
  return () => {
    list.removeEventListener('change', listener);
  };
}

function read(): boolean {
  return media()?.matches === true;
}

/** True when the user asked the system for reduced motion. */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, read, () => false);
}
