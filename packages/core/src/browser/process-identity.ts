/**
 * Process creation identity and the liveness boundary built on it.
 *
 * A recorded PID alone cannot answer "is the owner still running": the OS
 * reuses PIDs, so a stale record can point at an unrelated live process and
 * authorize exactly the deletion that must not happen. Every check here is
 * therefore made against the process's *creation identity* — never its age,
 * which is a heuristic that fails on a fast machine and on a slow one.
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import type {
  LivenessVerdict,
  ProcessIdentity,
  ProcessLivenessProbe,
} from './installation-types.js';

const run = promisify(execFile);

/** Marks a token the platform could not produce; comparison is then impossible. */
export const UNKNOWN_START_TOKEN = 'unknown';

const QUERY_TIMEOUT_MS = 5_000;

/**
 * Reads the creation token for a PID.
 *
 * Returns null when the process does not exist, and {@link UNKNOWN_START_TOKEN}
 * when it exists but the platform query failed — the two are different answers
 * and collapsing them would turn "cannot tell" into "safe to reclaim".
 */
export async function readStartToken(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  switch (platform) {
    case 'linux':
      return readLinuxStartToken(pid);
    case 'darwin':
      return readDarwinStartToken(pid);
    case 'win32':
      return readWindowsStartToken(pid);
    default:
      return processExists(pid) ? UNKNOWN_START_TOKEN : null;
  }
}

/** `/proc/<pid>/stat` field 22 is the boot-relative start time in clock ticks. */
async function readLinuxStartToken(pid: number): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return processExists(pid) ? UNKNOWN_START_TOKEN : null;
  }
  // The comm field may contain spaces and parentheses, so split after the last ')'.
  const tail = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
  const startTime = tail[19];
  return startTime !== undefined && startTime.length > 0
    ? `linux:${startTime}`
    : UNKNOWN_START_TOKEN;
}

async function readDarwinStartToken(pid: number): Promise<string | null> {
  try {
    const { stdout } = await run('ps', ['-o', 'lstart=', '-p', String(pid)], {
      timeout: QUERY_TIMEOUT_MS,
      windowsHide: true,
    });
    const value = stdout.trim();
    if (value.length === 0) return null;
    return `darwin:${value}`;
  } catch {
    return processExists(pid) ? UNKNOWN_START_TOKEN : null;
  }
}

async function readWindowsStartToken(pid: number): Promise<string | null> {
  try {
    const { stdout } = await run(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue; if ($p) { $p.CreationDate.ToFileTimeUtc() }`,
      ],
      { timeout: QUERY_TIMEOUT_MS, windowsHide: true },
    );
    const value = stdout.trim();
    if (value.length === 0) return processExists(pid) ? UNKNOWN_START_TOKEN : null;
    return `win32:${value}`;
  } catch {
    return processExists(pid) ? UNKNOWN_START_TOKEN : null;
  }
}

/** Signal-0 existence test. EPERM means the process exists under another user. */
export function processExists(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Captures the identity of a running process, or null if it is already gone. */
export async function identifyProcess(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): Promise<ProcessIdentity | null> {
  const startToken = await readStartToken(pid, platform);
  if (startToken === null) return null;
  return { pid, startToken };
}

let ownIdentity: ProcessIdentity | null = null;

/** Identity of the current process, computed once. */
export async function currentProcessIdentity(): Promise<ProcessIdentity> {
  if (ownIdentity !== null) return ownIdentity;
  const identified = await identifyProcess(process.pid);
  ownIdentity = identified ?? { pid: process.pid, startToken: UNKNOWN_START_TOKEN };
  return ownIdentity;
}

/** @internal Test seam — forgets the memoized identity of this process. */
export function resetCurrentProcessIdentity(): void {
  ownIdentity = null;
}

/** Real {@link ProcessLivenessProbe}. Injected everywhere so tests drive every verdict. */
export class NodeProcessLivenessProbe implements ProcessLivenessProbe {
  private readonly platform: NodeJS.Platform;

  constructor(deps: { readonly platform?: NodeJS.Platform } = {}) {
    this.platform = deps.platform ?? process.platform;
  }

  /** @inheritdoc */
  identify(pid: number): Promise<ProcessIdentity | null> {
    return identifyProcess(pid, this.platform);
  }

  /**
   * @inheritdoc
   *
   * A PID that does not exist is definitively dead whatever the platform can
   * tell us about creation times. A PID that *does* exist is alive only when
   * its creation token still matches: a different token means the PID was
   * reused and the recorded owner is gone.
   */
  async check(identity: ProcessIdentity): Promise<LivenessVerdict> {
    const token = await readStartToken(identity.pid, this.platform);
    if (token === null) return 'dead';
    if (token === UNKNOWN_START_TOKEN || identity.startToken === UNKNOWN_START_TOKEN)
      return 'unknown';
    return token === identity.startToken ? 'alive' : 'dead';
  }
}
