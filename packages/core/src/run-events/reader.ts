/**
 * Readers for `run-events.jsonl` (FEAT-063).
 *
 * A reader never trusts the tail: a line without its terminating `\n` may be
 * an append still in flight, or the remains of a crash, so it is never an
 * item. Only the writer (or, from FEAT-064, a reconciler that won its claim)
 * truncates such a tail before appending.
 */

import { closeSync, createReadStream, fstatSync, openSync, readSync } from 'node:fs';

import { parseRunEventLine, type RunEventReadItem } from '@yantra/protocol';

/** Where the valid part of a run-events file ends, and what it ends with. */
export interface RunEventsTail {
  /** `seq` of the last valid record, or 0 when the file has none. */
  readonly lastSeq: number;
  /** `event.kind` of the last valid record, or null. */
  readonly lastKind: string | null;
  /** Byte length of the file up to and including its last `\n`. */
  readonly validBytes: number;
  /** True when bytes follow the last `\n` (an unterminated final line). */
  readonly partialTail: boolean;
  /** Total file size in bytes. */
  readonly size: number;
}

const NEWLINE = 0x0a;
const INITIAL_WINDOW = 512 * 1024;
const TAIL_PROBE = 64 * 1024;

/**
 * Finds the last valid record and the end of the last complete line without
 * reading the whole file: it reads backwards from the end, widening its window
 * only while no valid line has been found.
 *
 * @param path The `run-events.jsonl` file.
 * @returns The tail summary; a missing file reads as empty.
 */
export function scanRunEventsTail(path: string): RunEventsTail {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { lastSeq: 0, lastKind: null, validBytes: 0, partialTail: false, size: 0 };
    }
    throw error;
  }
  try {
    const size = fstatSync(fd).size;
    const validBytes = lastNewlineEnd(fd, size);
    const last = lastValidRecord(fd, validBytes);
    return {
      lastSeq: last?.seq ?? 0,
      lastKind: last?.kind ?? null,
      validBytes,
      partialTail: validBytes < size,
      size,
    };
  } finally {
    closeSync(fd);
  }
}

/** Byte offset just past the last `\n`, or 0 when the file has none. */
function lastNewlineEnd(fd: number, size: number): number {
  let end = size;
  while (end > 0) {
    const start = Math.max(0, end - TAIL_PROBE);
    const chunk = Buffer.alloc(end - start);
    readSync(fd, chunk, 0, chunk.length, start);
    const index = chunk.lastIndexOf(NEWLINE);
    if (index !== -1) return start + index + 1;
    end = start;
  }
  return 0;
}

/** The last complete line (scanning backwards) that is a known envelope. */
function lastValidRecord(
  fd: number,
  validBytes: number,
): { readonly seq: number; readonly kind: string } | null {
  let window = INITIAL_WINDOW;
  for (;;) {
    const start = Math.max(0, validBytes - window);
    const chunk = Buffer.alloc(validBytes - start);
    readSync(fd, chunk, 0, chunk.length, start);
    const lines = chunk.toString('utf8').split('\n');
    lines.pop(); // the empty string after the final `\n`
    // A window that starts mid-file may begin mid-line; that line is re-read
    // whole by the next, wider window.
    const firstComplete = start === 0 ? 0 : 1;
    for (let index = lines.length - 1; index >= firstComplete; index--) {
      const line = lines[index] ?? '';
      if (line.length === 0) continue;
      const item = parseRunEventLine(line);
      if (item.status === 'event') return { seq: item.record.seq, kind: item.record.event.kind };
      if (item.status === 'unknown_kind') return { seq: item.seq, kind: item.kind };
    }
    if (start === 0) return null;
    window *= 2;
  }
}

/** Options for {@link readRunEvents}. */
export interface ReadRunEventsOptions {
  /** Yield records with `seq >= fromSeq` only; defaults to 1 (everything). */
  readonly fromSeq?: number;
}

/**
 * Streams a run's events line by line, so a 50,000-event file never loads
 * whole. A trailing partial line is ignored, never yielded. Invalid lines are
 * yielded as `invalid` items once the stream has reached `fromSeq`.
 *
 * @param path The `run-events.jsonl` file; a missing file yields nothing.
 * @param options Where to start.
 */
export async function* readRunEvents(
  path: string,
  options: ReadRunEventsOptions = {},
): AsyncGenerator<RunEventReadItem> {
  const fromSeq = options.fromSeq ?? 1;
  let lastSeq = 0;
  let carry = '';
  const stream = createReadStream(path, { encoding: 'utf8', highWaterMark: 64 * 1024 });
  try {
    for await (const chunk of stream as AsyncIterable<string>) {
      const lines = (carry + chunk).split('\n');
      // The last piece has no `\n` yet: it waits for the next chunk, and is
      // dropped if the file ends first.
      carry = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim().length === 0) continue;
        const item = parseRunEventLine(line);
        const seq =
          item.status === 'event'
            ? item.record.seq
            : item.status === 'unknown_kind'
              ? item.seq
              : null;
        if (seq !== null) {
          lastSeq = seq;
          if (seq >= fromSeq) yield item;
        } else if (lastSeq + 1 >= fromSeq) {
          yield item;
        }
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  } finally {
    stream.destroy();
  }
}
