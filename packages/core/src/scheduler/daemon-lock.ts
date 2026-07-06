/**
 * Single-instance lock for the scheduler daemon (FEAT-021 TASK-002).
 *
 * Wraps `proper-lockfile` behind a tiny interface so the daemon's
 * single-instance guarantee is testable without touching the real filesystem
 * lock. The lock also records the holder PID in a sidecar file so
 * `yantra daemon stop` can signal the running process and `status` can report
 * it (proper-lockfile itself stores no PID).
 *
 * Stale-lock recovery: `proper-lockfile` reclaims a lock whose holder has died
 * (mtime-based staleness). We surface that as a successful acquire — a crashed
 * daemon must not permanently wedge the scheduler.
 */

import { readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import lockfile from 'proper-lockfile';

import { dataDir } from '../browser/paths.js';

/** The daemon lock file path (proper-lockfile locks this file's directory entry). */
export function daemonLockPath(): string {
  return join(dataDir(), 'daemon.lock');
}

/** Sidecar recording the lock-holder PID (proper-lockfile stores none). */
export function daemonPidPath(): string {
  return join(dataDir(), 'daemon.pid');
}

/** Info about a currently-held daemon lock. */
export interface DaemonLockInfo {
  /** PID of the process holding the lock, or null if unknown. */
  readonly pid: number | null;
}

/**
 * The daemon's single-instance lock. Acquire returns a release handle; a second
 * acquire while held rejects with {@link DaemonLockHeldError}.
 */
export interface DaemonLock {
  /** Acquires the lock, or throws {@link DaemonLockHeldError} if another live instance holds it. */
  acquire(pid: number): Promise<() => Promise<void>>;
  /** Reads the current holder info, or null when the lock is free. */
  probe(): Promise<DaemonLockInfo | null>;
}

/** Thrown when a second daemon instance tries to acquire an already-held lock. */
export class DaemonLockHeldError extends Error {
  public override readonly name = 'DaemonLockHeldError';
  public constructor(public readonly holderPid: number | null) {
    super(
      holderPid === null
        ? 'The scheduler daemon is already running.'
        : `The scheduler daemon is already running (pid ${holderPid}).`,
    );
  }
}

/** Real {@link DaemonLock} backed by `proper-lockfile`. */
export class FileDaemonLock implements DaemonLock {
  private readonly lockTarget: string;
  private readonly pidFile: string;

  public constructor(opts: { lockTarget?: string; pidFile?: string } = {}) {
    this.lockTarget = opts.lockTarget ?? daemonLockPath();
    this.pidFile = opts.pidFile ?? daemonPidPath();
  }

  public async acquire(pid: number): Promise<() => Promise<void>> {
    // proper-lockfile locks an existing path; ensure the target file exists.
    await mkdir(dirname(this.lockTarget), { recursive: true, mode: 0o700 });
    await writeFile(this.lockTarget, '', { flag: 'a' });

    let release: () => Promise<void>;
    try {
      // `stale` reclaims a lock whose holder died (default 10s); `realpath:false`
      // avoids resolving symlinks that may not exist on first run.
      release = await lockfile.lock(this.lockTarget, {
        stale: 10_000,
        realpath: false,
        retries: 0,
      });
    } catch (error) {
      const holderPid = await this.readPid();
      throw new DaemonLockHeldError(holderPid ?? pidFromError(error));
    }

    await writeFile(this.pidFile, String(pid), 'utf8');

    return async (): Promise<void> => {
      try {
        await release();
      } finally {
        await rm(this.pidFile, { force: true }).catch(() => undefined);
      }
    };
  }

  public async probe(): Promise<DaemonLockInfo | null> {
    let locked: boolean;
    try {
      locked = await lockfile.check(this.lockTarget, { stale: 10_000, realpath: false });
    } catch {
      return null;
    }
    if (!locked) {
      return null;
    }
    return { pid: await this.readPid() };
  }

  private async readPid(): Promise<number | null> {
    try {
      const raw = (await readFile(this.pidFile, 'utf8')).trim();
      const pid = Number.parseInt(raw, 10);
      return Number.isFinite(pid) && pid > 0 ? pid : null;
    } catch {
      return null;
    }
  }
}

/** Best-effort extraction of a pid embedded in a proper-lockfile error. */
function pidFromError(error: unknown): number | null {
  if (error instanceof Error) {
    const maybePid = (error as unknown as { pid?: unknown }).pid;
    if (typeof maybePid === 'number' && Number.isFinite(maybePid)) {
      return maybePid;
    }
  }
  return null;
}
