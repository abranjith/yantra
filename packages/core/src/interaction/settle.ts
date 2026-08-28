/**
 * Read a moving surface once it stops moving.
 *
 * The fill engine used to wait a fixed 1.5 s for a suggestion popup and then
 * rank whatever happened to be on screen. That loses twice on a real remote
 * autocomplete: a list that answers late is never seen at all, and a list still
 * churning through the results of earlier keystrokes is ranked as if it were
 * final — which is how typing an airport code came back offering the wrong
 * city. Waiting for *stability* instead of for a duration fixes both, and costs
 * a fast page nothing beyond one extra poll.
 */

import { realSleep } from './types.js';

/** Bounds for one {@link readWhenStable} call. */
export interface StabilityOptions<TValue> {
  /** Consecutive identical reads required before the value is called settled. */
  readonly quietPolls: number;
  /** Pause between reads. */
  readonly pollMs: number;
  /** Absolute instant past which the last read is returned as-is. */
  readonly deadlineMs: number;
  /** Injectable clock. */
  readonly now: () => number;
  /** Minimum reads to take regardless of stability; defaults to 1. */
  readonly minReads?: number;
  /**
   * Gate on the *content*, not just its stability.
   *
   * An empty suggestion list is perfectly stable and completely useless, so a
   * caller waiting for suggestions supplies `accept` to keep polling until
   * something arrives. Without it, "nothing, twice" would settle instantly and
   * reintroduce the very race this module removes. Defaults to accepting
   * anything.
   */
  readonly accept?: (value: TValue) => boolean;
  /** Injectable delay, so tests never wait on real time. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** The settled (or timed-out) read. */
export interface StableRead<TValue> {
  readonly value: TValue;
  /** True when the value met `accept` and repeated `quietPolls` times. */
  readonly stable: boolean;
  /** How many reads were taken. */
  readonly reads: number;
}

/**
 * Poll `read` until its fingerprint repeats `quietPolls` times, or the deadline.
 *
 * On timeout the **last** value is returned with `stable: false` rather than an
 * error — a caller that has run out of patience still needs to see the best
 * available state, and turning "the page is slow" into a failure is what pushed
 * callers into operating widgets by hand.
 */
export async function readWhenStable<TValue>(
  read: () => Promise<TValue>,
  fingerprint: (value: TValue) => string,
  options: StabilityOptions<TValue>,
): Promise<StableRead<TValue>> {
  const sleep = options.sleep ?? realSleep;
  const accept = options.accept ?? ((): boolean => true);
  const quietPolls = Math.max(1, Math.floor(options.quietPolls));
  const minReads = Math.max(1, Math.floor(options.minReads ?? 1));

  let value = await read();
  let reads = 1;
  let previous = fingerprint(value);
  let repeats = 1;

  for (;;) {
    if (repeats >= quietPolls && reads >= minReads && accept(value)) {
      return { value, stable: true, reads };
    }
    if (options.now() + options.pollMs > options.deadlineMs) {
      return { value, stable: false, reads };
    }
    if (options.pollMs > 0) await sleep(options.pollMs);

    value = await read();
    reads += 1;
    const current = fingerprint(value);
    repeats = current === previous ? repeats + 1 : 1;
    previous = current;
  }
}
