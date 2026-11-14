/**
 * Bounded readers for run artifacts (FEAT-066 TASK-004).
 *
 * Neither reader ever calls `readFile` on a file it has not sized first:
 * {@link readCapped} stats before reading and refuses a file over its cap
 * without reading a byte, and {@link readTail} reads only the last N bytes.
 */

import { open as fsOpen, stat as fsStat } from 'node:fs/promises';

/** The filesystem calls the bounded readers make; injected in tests. */
export interface BoundedReadFs {
  stat(path: string): Promise<{ size: number; isFile(): boolean; mtime: Date }>;
  /** Reads `length` bytes at `position`. */
  readRange(path: string, position: number, length: number): Promise<Buffer>;
}

/** Node's `fs/promises`. */
export const NODE_BOUNDED_READ_FS: BoundedReadFs = {
  stat: (path) => fsStat(path),
  readRange: async (path, position, length) => {
    const handle = await fsOpen(path, 'r');
    try {
      const buffer = Buffer.alloc(length);
      let offset = 0;
      while (offset < length) {
        const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      return buffer.subarray(0, offset);
    } finally {
      await handle.close();
    }
  },
};

/** The result of {@link readCapped}. */
export type CappedRead =
  | { readonly state: 'ok'; readonly text: string; readonly bytes: number }
  | { readonly state: 'missing' }
  | { readonly state: 'too_large'; readonly bytes: number; readonly cap: number };

/**
 * Reads a whole UTF-8 file of at most `cap` bytes. Stats first: a file over
 * the cap is `too_large` and is never read. A missing path or a directory is
 * `missing`.
 */
export async function readCapped(
  path: string,
  cap: number,
  fs: BoundedReadFs = NODE_BOUNDED_READ_FS,
): Promise<CappedRead> {
  let size: number;
  try {
    const info = await fs.stat(path);
    if (!info.isFile()) return { state: 'missing' };
    size = info.size;
  } catch {
    return { state: 'missing' };
  }
  if (size > cap) return { state: 'too_large', bytes: size, cap };
  try {
    // Read one byte past the stat size: a file that grew past its cap since the
    // stat is still refused rather than silently cut.
    const buffer = await fs.readRange(path, 0, Math.min(size + 1, cap + 1));
    if (buffer.length > cap) return { state: 'too_large', bytes: buffer.length, cap };
    return { state: 'ok', text: buffer.toString('utf8'), bytes: buffer.length };
  } catch {
    return { state: 'missing' };
  }
}

/**
 * The first `cap` bytes of a file, cut back to the last complete line, with
 * the file's real size. Used to show the head of an oversized `report.md`.
 */
export async function readHead(
  path: string,
  cap: number,
  fs: BoundedReadFs = NODE_BOUNDED_READ_FS,
): Promise<{ readonly text: string; readonly bytes: number; readonly truncated: boolean } | null> {
  let size: number;
  try {
    const info = await fs.stat(path);
    if (!info.isFile()) return null;
    size = info.size;
  } catch {
    return null;
  }
  const buffer = await fs.readRange(path, 0, Math.min(size, cap)).catch(() => null);
  if (buffer === null) return null;
  if (size <= cap) return { text: buffer.toString('utf8'), bytes: size, truncated: false };
  const lastNewline = buffer.lastIndexOf(0x0a);
  const kept = lastNewline >= 0 ? buffer.subarray(0, lastNewline + 1) : buffer;
  return { text: kept.toString('utf8'), bytes: size, truncated: true };
}

/**
 * The last `bytes` bytes of a file, starting at a line boundary: when the read
 * does not begin at the start of the file, the first (partial) line is
 * dropped. A missing file reads as `null`.
 */
export async function readTail(
  path: string,
  bytes: number,
  fs: BoundedReadFs = NODE_BOUNDED_READ_FS,
): Promise<string | null> {
  let size: number;
  try {
    const info = await fs.stat(path);
    if (!info.isFile()) return null;
    size = info.size;
  } catch {
    return null;
  }
  const start = Math.max(0, size - bytes);
  const buffer = await fs.readRange(path, start, size - start).catch(() => null);
  if (buffer === null) return null;
  if (start === 0) return buffer.toString('utf8');
  const firstNewline = buffer.indexOf(0x0a);
  return firstNewline < 0 ? '' : buffer.subarray(firstNewline + 1).toString('utf8');
}
