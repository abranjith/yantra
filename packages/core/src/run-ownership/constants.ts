/**
 * Run ownership and run channel thresholds (FEAT-064). They are open questions
 * in plan §15, so they live in one place.
 */

/** `<runDir>/lease.json`: who owns the run, written once by `link`. */
export const RUN_LEASE_FILENAME = 'lease.json';

/** `<runDir>/owned-browsers.jsonl`: append-only record of browsers the run spawned. */
export const OWNED_BROWSERS_FILENAME = 'owned-browsers.jsonl';

/** `<runDir>/reconcile.lock`: held only while reconciling or taking over a run. */
export const RECONCILE_LOCK_FILENAME = 'reconcile.lock';

/** The pre-FEAT-064 ownership marker, still read for legacy reconciliation. */
export const LEGACY_LOCK_FILENAME = '.lock';

/** How often the owner sends `heartbeat` on each connection. */
export const HEARTBEAT_INTERVAL_MS = 5_000;

/** A client with no frame of any kind for this long reports `not_responding`. */
export const NOT_RESPONDING_AFTER_MS = 30_000;

/** Encoded bytes a connection's event queue may hold before it is dropped. */
export const OUTBOUND_EVENT_QUEUE_BYTES = 8 * 1024 * 1024;

/** How long a stop waits for a cancelled run to end before forcing it. */
export const STOP_GRACE_MS = 10_000;

/** How long a new connection has to send its `hello`. */
export const HELLO_DEADLINE_MS = 5_000;

/** How long `finish()` waits for connections to close before releasing the lease (RC3). */
export const FINISH_DRAIN_MS = 1_000;

/** `proper-lockfile` staleness for `reconcile.lock`. */
export const RECONCILE_LOCK_STALE_MS = 10_000;

/** How long a reconciler waits for a terminated browser to be confirmed dead. */
export const REAP_CONFIRM_MS = 5_000;

/** First and largest client reconnect delay. */
export const RECONNECT_INITIAL_MS = 250;
export const RECONNECT_MAX_MS = 5_000;
