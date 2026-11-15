/**
 * A bounded, append-only log with structural sharing (FEAT-067 TASK-001).
 *
 * The cockpit keeps the newest N timeline and inspector entries of a run that
 * may have tens of thousands of events. Copying an N-entry array per event
 * would make a 50,000-event replay quadratic, so entries live in fixed-size
 * frozen chunks: an append copies only the last chunk (at most
 * {@link LOG_CHUNK} entries) and the short chunk list, and older chunks are
 * shared between versions. Every operation returns a new log and never
 * mutates its input, so the reducer that uses it stays pure.
 */

/** Entries per chunk: the most an append or a replace copies. */
export const LOG_CHUNK = 64;

/** An immutable bounded log; see the module comment. */
export interface BoundedLog<T> {
  /** Frozen chunks, oldest first; only the last may be partly filled. */
  readonly chunks: readonly (readonly T[])[];
  /** Entries of `chunks[0]` already dropped from the front. */
  readonly head: number;
  /** Entries currently held (at most `cap`). */
  readonly size: number;
  /** Entries ever appended, including those dropped. */
  readonly total: number;
  /** Most entries held at once. */
  readonly cap: number;
}

/** An empty log holding at most `cap` entries. */
export function emptyLog<T>(cap: number): BoundedLog<T> {
  if (!Number.isInteger(cap) || cap < 1)
    throw new RangeError('A bounded log needs a cap of 1 or more.');
  return { chunks: [], head: 0, size: 0, total: 0, cap };
}

/** The log with `item` appended; the oldest entry is dropped once the cap is reached. */
export function appendLog<T>(log: BoundedLog<T>, item: T): BoundedLog<T> {
  const last = log.chunks.at(-1);
  let chunks: (readonly T[])[];
  if (last !== undefined && last.length < LOG_CHUNK) {
    chunks = [...log.chunks.slice(0, -1), Object.freeze([...last, item])];
  } else {
    chunks = [...log.chunks, Object.freeze([item])];
  }
  let head = log.head;
  let size = log.size + 1;
  if (size > log.cap) {
    head += 1;
    size -= 1;
    if (head >= (chunks[0]?.length ?? 0)) {
      chunks = chunks.slice(1);
      head = 0;
    }
  }
  return { chunks, head, size, total: log.total + 1, cap: log.cap };
}

/**
 * The absolute index (0-based, counting dropped entries) of the oldest entry
 * still held.
 */
export function firstIndex(log: BoundedLog<unknown>): number {
  return log.total - log.size;
}

function locate(log: BoundedLog<unknown>, absolute: number): [number, number] | null {
  const relative = absolute - firstIndex(log);
  if (!Number.isInteger(relative) || relative < 0 || relative >= log.size) return null;
  let offset = relative + log.head;
  for (let chunk = 0; chunk < log.chunks.length; chunk += 1) {
    const length = log.chunks[chunk]!.length;
    if (offset < length) return [chunk, offset];
    offset -= length;
  }
  return null;
}

/** The entry at absolute index `absolute`, or undefined once dropped or not yet written. */
export function logAt<T>(log: BoundedLog<T>, absolute: number): T | undefined {
  const at = locate(log, absolute);
  return at === null ? undefined : log.chunks[at[0]]![at[1]];
}

/**
 * The log with the entry at absolute index `absolute` replaced; the same log
 * when that entry is no longer held.
 */
export function replaceLog<T>(log: BoundedLog<T>, absolute: number, item: T): BoundedLog<T> {
  const at = locate(log, absolute);
  if (at === null) return log;
  const [chunkIndex, offset] = at;
  const chunk = [...log.chunks[chunkIndex]!];
  chunk[offset] = item;
  const chunks = [...log.chunks];
  chunks[chunkIndex] = Object.freeze(chunk);
  return { ...log, chunks };
}

const flattened = new WeakMap<BoundedLog<unknown>, readonly unknown[]>();

/** The held entries, oldest first. Memoized per log version, so rendering pays once. */
export function logEntries<T>(log: BoundedLog<T>): readonly T[] {
  const cached = flattened.get(log);
  if (cached !== undefined) return cached as readonly T[];
  const out: T[] = [];
  log.chunks.forEach((chunk, index) => {
    for (let offset = index === 0 ? log.head : 0; offset < chunk.length; offset += 1) {
      out.push(chunk[offset]!);
    }
  });
  const frozen = Object.freeze(out);
  flattened.set(log, frozen);
  return frozen;
}
