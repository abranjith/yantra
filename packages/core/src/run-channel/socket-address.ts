import { randomBytes } from 'node:crypto';
import { lstat, mkdir, rm } from 'node:fs/promises';
import { dirname, join, relative, isAbsolute } from 'node:path';

import type { RunSocketAddress } from '@yantra/protocol';

import { RUN_PIPE_PREFIX, socketsRoot } from '../browser/paths.js';
import { RunOwnershipError } from '../run-ownership/errors.js';

/**
 * Creates the run-socket directory owner-only (`0700`) and verifies it before
 * use: a real directory (not a symlink), owned by this user, with no group or
 * other permission bits. An existing unsafe directory is refused, never
 * repaired. On Windows there is no directory: pipe names are unguessable.
 *
 * @throws RunOwnershipError `RUN_OWNERSHIP_SOCKET_DIR_UNSAFE`.
 */
export async function ensureSocketsRoot(
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  const root = socketsRoot(platform);
  if (platform === 'win32') return root;
  await mkdir(dirname(root), { recursive: true, mode: 0o700 });
  try {
    await mkdir(root, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const stat = await lstat(root);
  const uid = typeof process.getuid === 'function' ? process.getuid() : stat.uid;
  const problem = stat.isSymbolicLink()
    ? 'is a symbolic link'
    : !stat.isDirectory()
      ? 'is not a directory'
      : stat.uid !== uid
        ? 'is owned by another user'
        : (stat.mode & 0o077) !== 0
          ? 'is accessible to other users'
          : null;
  if (problem !== null) {
    throw new RunOwnershipError(
      'RUN_OWNERSHIP_SOCKET_DIR_UNSAFE',
      `The run socket directory ${root} ${problem}; remove it or fix its permissions (0700, owned by you), then retry.`,
    );
  }
  return root;
}

/** A fresh, unguessable run socket address: a Unix socket path or a named pipe. */
export async function allocateSocketAddress(
  platform: NodeJS.Platform = process.platform,
): Promise<RunSocketAddress> {
  const root = await ensureSocketsRoot(platform);
  if (platform === 'win32') {
    return { kind: 'pipe', address: `${RUN_PIPE_PREFIX}${randomBytes(16).toString('hex')}` };
  }
  return { kind: 'unix', address: join(root, `${randomBytes(12).toString('hex')}.sock`) };
}

/**
 * Removes a stale Unix socket file, but only one inside the sockets root, so a
 * forged lease can never make Yantra delete an arbitrary path.
 */
export async function removeStaleSocket(address: RunSocketAddress): Promise<boolean> {
  if (address.kind !== 'unix') return false;
  const rel = relative(socketsRoot(), address.address);
  if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel) || rel.includes('/')) {
    return false;
  }
  await rm(address.address, { force: true });
  return true;
}
