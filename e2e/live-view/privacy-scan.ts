/**
 * Byte scans and rate sampling for the live-view evidence suite (FEAT-069
 * TASK-012). Vitest-free (memory: harness modules stay Vitest-free).
 *
 * Frames must never be written anywhere. A JPEG starts with the SOI marker
 * followed by another marker, `\xFF\xD8\xFF`; this scans every byte of every
 * file (an explicit byte scan, never `grep`, per memory) and skips only the
 * image artifacts a run legitimately owns.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';

/** The JPEG start-of-image marker plus the first byte of the next marker. */
export const JPEG_SIGNATURE: readonly number[] = [0xff, 0xd8, 0xff];

/** Image artifacts a run may own on its own (screenshots and captures), skipped by the scan. */
export const OWNED_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
]);

/** Offset of the first JPEG signature in `bytes`, or -1. */
export function findJpegSignature(bytes: Uint8Array): number {
  const [a, b, c] = JPEG_SIGNATURE as [number, number, number];
  for (let index = 0; index + 2 < bytes.length; index += 1) {
    if (bytes[index] === a && bytes[index + 1] === b && bytes[index + 2] === c) return index;
  }
  return -1;
}

/** One finding: a non-image file that holds a JPEG signature, or a file named for frames. */
export interface FrameLeak {
  readonly path: string;
  readonly reason: 'jpeg_bytes' | 'frame_named';
  readonly offset?: number;
}

/** Scans every file under `root` (recursively). */
export function scanForFrames(root: string): FrameLeak[] {
  const leaks: FrameLeak[] = [];
  for (const entry of readdirSync(root, { recursive: true, encoding: 'utf8' })) {
    const path = join(root, entry);
    if (!statSync(path).isFile()) continue;
    const name = relative(root, path).split(sep).join('/');
    if (/(?:^|\/)(?:frame|screencast)[^/]*$/iu.test(name)) {
      leaks.push({ path: name, reason: 'frame_named' });
    }
    if (OWNED_IMAGE_EXTENSIONS.has(extname(name).toLowerCase())) continue;
    const offset = findJpegSignature(readFileSync(path));
    if (offset >= 0) leaks.push({ path: name, reason: 'jpeg_bytes', offset });
  }
  return leaks;
}

/** Frames per second over arrival times (ms), from the first to the last. */
export function arrivalRate(times: readonly number[]): number {
  if (times.length < 2) return 0;
  const span = (times[times.length - 1] ?? 0) - (times[0] ?? 0);
  return span > 0 ? ((times.length - 1) * 1000) / span : 0;
}
