/**
 * Windowed reads of JSONL artifacts of any length (FEAT-066 TASK-008).
 *
 * {@link SparseLineIndex} records the byte offset of every 1,024th line. It is
 * built lazily, only as far as a request needs, so {@link JsonlWindow}'s
 * `total_complete` stays false until a read has reached the end of the file.
 * Entries are kept per file (its real path) in an LRU of 16:
 *
 * - a file that only grew (a live run) extends its index from where it
 *   stopped, never rebuilding;
 * - a file that shrank, or changed without growing, is indexed afresh.
 *
 * {@link readJsonlWindow} seeks to the nearest checkpoint and reads forward.
 * Each line is cut at {@link JSONL_LINE_MAX_BYTES} (`truncated_bytes` says how
 * much was left out) and a window stops before its serialized size would pass
 * {@link JSONL_WINDOW_MAX_BYTES}. A trailing line with no newline yet is never
 * returned; `partial_tail` reports it.
 */

import { open as fsOpen, realpath as fsRealpath, stat as fsStat } from 'node:fs/promises';

import { JSONL_LINE_MAX_BYTES, JSONL_WINDOW_MAX_BYTES, type JsonlWindow } from '@yantra/protocol';

/** Lines between two index checkpoints. */
export const CHECKPOINT_LINES = 1_024;
/** Files whose index is kept. */
export const LINE_INDEX_CAPACITY = 16;
const CHUNK_BYTES = 64 * 1024;

/** An open file the reader pulls bytes from. */
export interface WindowFileHandle {
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

/** The filesystem calls the reader makes; injected in tests to count reads. */
export interface JsonlWindowFs {
  open(path: string): Promise<WindowFileHandle>;
  stat(path: string): Promise<{ size: number; mtimeMs: number }>;
  realpath(path: string): Promise<string>;
}

/** Node's `fs/promises`. */
export const NODE_JSONL_WINDOW_FS: JsonlWindowFs = {
  open: async (path) => {
    const handle = await fsOpen(path, 'r');
    return {
      read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
      close: () => handle.close(),
    };
  },
  stat: (path) => fsStat(path),
  realpath: (path) => fsRealpath(path),
};

/** The index of one file. */
interface IndexEntry {
  size: number;
  mtimeMs: number;
  /** checkpoints[k] = byte offset where line k * CHECKPOINT_LINES starts. */
  readonly checkpoints: number[];
  /** Complete (newline-terminated) lines counted. */
  lines: number;
  /** Byte offset just past the last newline counted. */
  scanned: number;
  /** The scan has reached the end of the file at its current size. */
  complete: boolean;
}

/** What an index build did, for the host's debug log. */
export interface IndexBuildEvent {
  readonly lines: number;
  readonly durationMs: number;
  readonly rebuilt: boolean;
}

/** The per-file sparse line index; see the module comment. */
export class SparseLineIndex {
  private readonly entries = new Map<string, IndexEntry>();

  public constructor(
    private readonly capacity = LINE_INDEX_CAPACITY,
    private readonly onBuild?: (event: IndexBuildEvent) => void,
  ) {}

  /** Files currently indexed. */
  public get size(): number {
    return this.entries.size;
  }

  /** The entry for a file at its current size and time, reset when it was edited. */
  public entryFor(
    realPath: string,
    size: number,
    mtimeMs: number,
  ): { entry: IndexEntry; rebuilt: boolean } {
    let entry = this.entries.get(realPath);
    let rebuilt = false;
    const grewOnly = entry !== undefined && size > entry.size;
    const unchanged = size === entry?.size && mtimeMs === entry.mtimeMs;
    if (entry === undefined || (!grewOnly && !unchanged)) {
      rebuilt = entry !== undefined;
      entry = { size, mtimeMs, checkpoints: [0], lines: 0, scanned: 0, complete: false };
    } else if (grewOnly) {
      // Appended to: keep every checkpoint, continue from the last newline.
      entry.size = size;
      entry.mtimeMs = mtimeMs;
      entry.complete = false;
    }
    this.entries.delete(realPath);
    this.entries.set(realPath, entry);
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return { entry, rebuilt };
  }

  /** Reports a build to the observer. */
  public built(event: IndexBuildEvent): void {
    this.onBuild?.(event);
  }
}

/** Counts lines from `entry.scanned` until `target` lines are known or the file ends. */
async function extendIndex(
  handle: WindowFileHandle,
  entry: IndexEntry,
  target: number,
): Promise<void> {
  if (entry.complete || entry.lines >= target) return;
  const buffer = Buffer.alloc(CHUNK_BYTES);
  let position = entry.scanned;
  while (position < entry.size && entry.lines < target) {
    const length = Math.min(CHUNK_BYTES, entry.size - position);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    if (bytesRead === 0) break;
    let index = buffer.indexOf(0x0a, 0);
    while (index !== -1 && index < bytesRead) {
      entry.lines += 1;
      entry.scanned = position + index + 1;
      if (entry.lines % CHECKPOINT_LINES === 0) entry.checkpoints.push(entry.scanned);
      if (entry.lines >= target) return;
      index = buffer.indexOf(0x0a, index + 1);
    }
    position += bytesRead;
  }
  if (position >= entry.size) entry.complete = true;
}

/** The longest prefix of `bytes` that ends on a UTF-8 character boundary. */
function utf8Prefix(bytes: Buffer, max: number): Buffer {
  if (bytes.length <= max) return bytes;
  let end = max;
  // Back off over continuation bytes (10xxxxxx) so no character is split.
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end);
}

/** One line read for a window. */
interface ReadLine {
  readonly n: number;
  readonly text: string;
  readonly truncated_bytes: number;
}

/** Reads complete lines `[from, from + limit)` that lie before `entry.scanned`. */
async function readLines(
  handle: WindowFileHandle,
  entry: IndexEntry,
  from: number,
  limit: number,
): Promise<ReadLine[]> {
  const out: ReadLine[] = [];
  if (from >= entry.lines) return out;
  const checkpoint = Math.min(Math.floor(from / CHECKPOINT_LINES), entry.checkpoints.length - 1);
  let line = checkpoint * CHECKPOINT_LINES;
  let position = entry.checkpoints[checkpoint]!;
  const end = entry.scanned;
  const buffer = Buffer.alloc(CHUNK_BYTES);
  let kept: Buffer[] = [];
  let keptBytes = 0;
  let lineBytes = 0;
  let windowBytes = 2; // the surrounding array brackets
  const last = Math.min(from + limit, entry.lines);

  while (position < end && line < last) {
    const length = Math.min(CHUNK_BYTES, end - position);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    if (bytesRead === 0) break;
    let start = 0;
    while (start < bytesRead && line < last) {
      const newline = buffer.indexOf(0x0a, start);
      const stop = newline === -1 || newline >= bytesRead ? bytesRead : newline;
      if (line >= from && keptBytes < JSONL_LINE_MAX_BYTES + 4) {
        const piece = buffer.subarray(start, stop);
        const room = JSONL_LINE_MAX_BYTES + 4 - keptBytes;
        const taken = piece.subarray(0, Math.min(room, piece.length));
        kept.push(Buffer.from(taken));
        keptBytes += taken.length;
      }
      lineBytes += stop - start;
      if (stop === bytesRead) break;
      // A complete line.
      if (line >= from) {
        const whole = Buffer.concat(kept);
        const visible = utf8Prefix(
          whole.subarray(0, Math.min(whole.length, lineBytes)),
          JSONL_LINE_MAX_BYTES,
        );
        const text = visible.toString('utf8').replace(/\r$/u, '');
        const item = { n: line, text, truncated_bytes: Math.max(0, lineBytes - visible.length) };
        const cost = Buffer.byteLength(JSON.stringify(item), 'utf8') + 1;
        if (out.length > 0 && windowBytes + cost > JSONL_WINDOW_MAX_BYTES - 512) return out;
        windowBytes += cost;
        out.push(item);
      }
      line += 1;
      kept = [];
      keptBytes = 0;
      lineBytes = 0;
      start = stop + 1;
    }
    position += bytesRead;
  }
  return out;
}

/**
 * One window of a JSONL file; see the module comment.
 *
 * @param absPath - A path already through the public-artifact gate.
 */
export async function readJsonlWindow(
  absPath: string,
  fromLine: number,
  limit: number,
  cache: SparseLineIndex,
  fs: JsonlWindowFs = NODE_JSONL_WINDOW_FS,
): Promise<Omit<JsonlWindow, 'path'>> {
  const realPath = await fs.realpath(absPath);
  const info = await fs.stat(realPath);
  const { entry, rebuilt } = cache.entryFor(realPath, info.size, info.mtimeMs);
  const handle = await fs.open(realPath);
  try {
    const before = entry.lines;
    const started = Date.now();
    await extendIndex(handle, entry, fromLine + limit);
    if (entry.lines !== before || rebuilt) {
      cache.built({ lines: entry.lines, durationMs: Date.now() - started, rebuilt });
    }
    const lines = await readLines(handle, entry, fromLine, limit);
    return {
      total_lines_known: entry.lines,
      total_complete: entry.complete,
      from_line: fromLine,
      lines,
      partial_tail: entry.complete && entry.size > entry.scanned,
    };
  } finally {
    await handle.close();
  }
}
