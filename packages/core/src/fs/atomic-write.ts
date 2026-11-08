import { randomBytes } from 'node:crypto';
import { link, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/** A sibling staging name unique to this process and write. */
export function uniqueTempPath(path: string): string {
  return `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
}

export interface AtomicWriteOptions {
  readonly mode?: number;
  /** Flush staged bytes before publication (used by durable manifests). */
  readonly fsync?: boolean;
  /** Atomically publish only if the final name does not already exist. */
  readonly exclusive?: boolean;
}

/**
 * Publish a complete file by sibling rename. Exclusive staging prevents writers
 * from sharing a temporary file; callers still need a lock for read-modify-write.
 */
export async function writeFileAtomic(
  path: string,
  data: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = uniqueTempPath(path);
  let staged = false;
  try {
    const file = await open(temporary, 'wx', options.mode ?? 0o600);
    staged = true;
    try {
      await file.writeFile(data);
      if (options.mode !== undefined) await file.chmod(options.mode);
      if (options.fsync === true) await file.sync();
    } finally {
      await file.close();
    }
    for (let attempt = 0; ; attempt++) {
      try {
        // A hard link publishes the complete staged inode and fails with EEXIST
        // instead of replacing an immutable receipt. Both names are siblings.
        if (options.exclusive) await link(temporary, path);
        else await rename(temporary, path);
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (process.platform !== 'win32' || code !== 'EPERM' || attempt >= 4) throw error;
        // Windows virus scanners/readers can briefly hold the destination open.
        await delay(25 * (attempt + 1));
      }
    }
  } finally {
    if (staged) await rm(temporary, { force: true });
  }
}
