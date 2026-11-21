/**
 * In-process notice that this process just claimed a run's lease (review
 * REV-011).
 *
 * An app-launched worker must record which run it owns. It used to find out
 * by scanning every run directory's `lease.json` four times a second. Instead,
 * {@link RunOwnershipSession.open} announces each lease it claims, and the
 * worker's invocation lifecycle listens.
 */

import type { RunLease } from '@yantra/protocol';

type Listener = (lease: RunLease) => void;

const listeners = new Set<Listener>();

/** Calls `listener` with every lease this process claims from now on. */
export function onRunLeaseClaimed(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Announces a lease this process just claimed. Listener errors never escape. */
export function announceRunLeaseClaimed(lease: RunLease): void {
  for (const listener of [...listeners]) {
    try {
      listener(lease);
    } catch {
      // A listener's failure must not fail the run that claimed the lease.
    }
  }
}
