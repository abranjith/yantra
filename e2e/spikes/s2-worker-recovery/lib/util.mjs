// Spike S2 (FEAT-064 TASK-001) — shared helpers. Throwaway prototype code.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, linkSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

export const IS_WIN = process.platform === 'win32';

export function sleep(ms) {
  return delay(ms);
}

export function now() {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

/** Polls `predicate` until it returns a truthy value or `timeoutMs` elapses. */
export async function waitFor(predicate, timeoutMs, stepMs = 25) {
  const deadline = now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (now() >= deadline) return null;
    await sleep(stepMs);
  }
}

export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/** Kills exactly one process, never its tree: SIGKILL, or `taskkill /F` without `/T`. */
export function hardKill(pid) {
  if (IS_WIN) {
    try {
      execFileSync('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
    } catch {
      // Already gone.
    }
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

/** Kills a process tree: `taskkill /T /F` on Windows, the process group on POSIX. */
export function treeKill(pid) {
  if (IS_WIN) {
    try {
      execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      // Already gone.
    }
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    hardKill(pid);
  }
}

export function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

export function uniqueTemp(path) {
  return `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
}

/** Exclusive publication: unique temp file, then `link` (EEXIST if one exists). */
export function exclusivePublish(path, value, mode = 0o600) {
  const temp = uniqueTemp(path);
  writeFileSync(temp, `${JSON.stringify(value)}\n`, { mode, flag: 'wx' });
  try {
    linkSync(temp, path);
  } finally {
    try {
      unlinkSync(temp);
    } catch {
      // Best effort.
    }
  }
}

/**
 * Temp-then-rename update with a bounded retry on Windows sharing errors.
 * Returns the number of retries the write needed.
 */
export function atomicReplace(path, value, { retries = 8, onRetry } = {}) {
  const temp = uniqueTemp(path);
  writeFileSync(temp, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(temp, path);
      return attempt;
    } catch (error) {
      const retryable = error.code === 'EPERM' || error.code === 'EBUSY' || error.code === 'EACCES';
      onRetry?.(error.code);
      if (!retryable || attempt >= retries) {
        try {
          unlinkSync(temp);
        } catch {
          // Best effort.
        }
        throw error;
      }
      // Synchronous back-off keeps the helper usable from synchronous paths.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5 * (attempt + 1));
    }
  }
}

export function removeIfExists(path) {
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Complete lines only: a trailing partial line is ignored, as the real reader must. */
export function readCompleteLines(path) {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf8');
  const end = raw.lastIndexOf('\n');
  if (end < 0) return [];
  return raw
    .slice(0, end)
    .split('\n')
    .filter((line) => line.length > 0);
}

export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

/** Lists PIDs whose command line contains `marker`, using the platform's process table. */
export function pidsWithMarker(marker) {
  try {
    if (IS_WIN) {
      // Excludes this query's own PowerShell, whose command line necessarily contains the marker.
      const script = `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains('${marker.replace(/'/g, "''")}') } | ForEach-Object { $_.ProcessId }`;
      const out = execFileSync(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 20_000,
        },
      );
      return out
        .split(/\r?\n/)
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isInteger(n) && n > 0);
    }
    const out = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
    return out
      .split('\n')
      .filter((line) => line.includes(marker) && !line.includes('ps -axo'))
      .map((line) => Number(line.trim().split(/\s+/)[0]))
      .filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
  } catch {
    return [];
  }
}

/** Reads a process's command line for the argv-privacy check. */
export function commandLineOf(pid) {
  try {
    if (process.platform === 'linux') {
      return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ').trim();
    }
    if (IS_WIN) {
      return execFileSync(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
        ],
        { encoding: 'utf8', windowsHide: true, timeout: 20_000 },
      ).trim();
    }
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

/** Parent PID of a Windows process, through CIM. */
export function windowsParentPid(pid) {
  try {
    const out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ParentProcessId`,
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 20_000 },
    );
    const n = Number(out.trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}
