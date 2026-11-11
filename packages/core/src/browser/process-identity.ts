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

/**
 * Starts computing this process's identity in the background, so the first
 * lease claim does not wait for it (~0.6 s on Windows; spike S2, RC4).
 */
export function warmProcessIdentity(): void {
  void currentProcessIdentity().catch(() => undefined);
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
    // Signal 0 first: a missing PID is dead without a platform query, which
    // costs ~0.6 s per call on Windows (spike S2, RC4).
    if (!processExists(identity.pid)) return 'dead';
    const token = await readStartToken(identity.pid, this.platform);
    return verdictFor(identity, token);
  }

  /**
   * Checks several identities with one platform query for every PID that
   * exists (one CIM query on Windows, one `ps` on macOS). Results are in input
   * order. A failed batch query answers `unknown`, never `dead`.
   */
  async checkMany(identities: readonly ProcessIdentity[]): Promise<LivenessVerdict[]> {
    const existing = [
      ...new Set(identities.filter((entry) => processExists(entry.pid)).map((entry) => entry.pid)),
    ];
    const tokens = await readStartTokens(existing, this.platform);
    return identities.map((identity) =>
      existing.includes(identity.pid)
        ? verdictFor(identity, tokens.get(identity.pid) ?? null)
        : 'dead',
    );
  }
}

function verdictFor(identity: ProcessIdentity, token: string | null): LivenessVerdict {
  if (token === null) return 'dead';
  if (token === UNKNOWN_START_TOKEN || identity.startToken === UNKNOWN_START_TOKEN)
    return 'unknown';
  return token === identity.startToken ? 'alive' : 'dead';
}

/**
 * Start tokens for several PIDs. A PID missing from a successful batch answer
 * re-checks existence (null when gone); a failed batch query answers
 * {@link UNKNOWN_START_TOKEN} for every PID that still exists.
 */
export async function readStartTokens(
  pids: readonly number[],
  platform: NodeJS.Platform = process.platform,
): Promise<Map<number, string | null>> {
  const result = new Map<number, string | null>();
  const valid = pids.filter((pid) => Number.isInteger(pid) && pid > 0);
  if (valid.length === 0) return result;
  if (platform !== 'win32' && platform !== 'darwin') {
    await Promise.all(
      valid.map(async (pid) => result.set(pid, await readStartToken(pid, platform))),
    );
    return result;
  }
  let lines: string[];
  try {
    const { stdout } =
      platform === 'win32'
        ? await run(
            'powershell',
            [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              `Get-CimInstance Win32_Process -Filter "${valid.map((pid) => `ProcessId=${pid}`).join(' OR ')}" -ErrorAction SilentlyContinue | ForEach-Object { "$($_.ProcessId) $($_.CreationDate.ToFileTimeUtc())" }`,
            ],
            { timeout: QUERY_TIMEOUT_MS * 2, windowsHide: true },
          )
        : await run('ps', ['-o', 'pid=,lstart=', '-p', valid.join(',')], {
            timeout: QUERY_TIMEOUT_MS * 2,
            windowsHide: true,
          });
    lines = stdout.split(/\r?\n/u);
  } catch (error) {
    // `ps` exits 1 when none of the PIDs exist; its stdout still holds any rows.
    const stdout = (error as { stdout?: unknown }).stdout;
    if (platform === 'darwin' && typeof stdout === 'string') lines = stdout.split(/\r?\n/u);
    else {
      for (const pid of valid) result.set(pid, processExists(pid) ? UNKNOWN_START_TOKEN : null);
      return result;
    }
  }
  const prefix = platform === 'win32' ? 'win32' : 'darwin';
  for (const line of lines) {
    const match = /^\s*(\d+)\s+(.+?)\s*$/u.exec(line);
    if (match === null) continue;
    const pid = Number(match[1]);
    if (valid.includes(pid)) result.set(pid, `${prefix}:${match[2]}`);
  }
  for (const pid of valid) {
    if (!result.has(pid)) result.set(pid, processExists(pid) ? UNKNOWN_START_TOKEN : null);
  }
  return result;
}

/**
 * Checks identities through {@link ProcessLivenessProbe.checkMany} when the
 * probe has it, otherwise one `check` per identity.
 */
export async function checkIdentities(
  probe: ProcessLivenessProbe,
  identities: readonly ProcessIdentity[],
): Promise<LivenessVerdict[]> {
  if (identities.length === 0) return [];
  if (probe.checkMany !== undefined) return probe.checkMany(identities);
  return Promise.all(identities.map((identity) => probe.check(identity)));
}
