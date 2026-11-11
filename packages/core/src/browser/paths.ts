import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { cacheDir, dataDir, resetPathCache, resolveStorageDirs } from '../config/resolved-paths.js';

export { cacheDir, dataDir, resetPathCache, resolveStorageDirs };

/** Returns the single platform-independent Yantra home directory. */
export function yantraHome(): string {
  const override = process.env.YANTRA_HOME?.trim();
  if (override) return override;
  return join(homedir(), '.yantra');
}

/** @example dataDir() // -> "/home/user/.yantra/data" */
/** @example cacheDir() // -> "/home/user/.yantra/cache" */

/** Returns the root directory where per-workflow Chrome profiles are stored. */
export function profilesRoot(): string {
  return join(dataDir(), 'profiles');
}

/** Returns the OS temporary directory used for ephemeral profiles. */
export function ephemeralRoot(): string {
  return tmpdir();
}

/** Returns the root directory where per-run artifacts are stored. */
export function runsRoot(): string {
  return join(dataDir(), 'runs');
}

/** Longest Unix socket path used; `sun_path` is 104 bytes on macOS, 108 on Linux. */
export const MAX_UNIX_SOCKET_PATH_BYTES = 100;

/** A run socket file name: 24 hex characters plus `.sock`. */
const SOCKET_NAME_SAMPLE = `${'0'.repeat(24)}.sock`;

/** The Windows named-pipe prefix every run socket name starts with. */
export const RUN_PIPE_PREFIX = '\\\\.\\pipe\\yantra-';

/**
 * Where run sockets live (FEAT-064).
 *
 * - POSIX: `<yantraHome>/run` when a socket path inside it fits in
 *   {@link MAX_UNIX_SOCKET_PATH_BYTES}; otherwise `<os.tmpdir()>/yantra-<uid>`.
 *   The caller creates it `0700` and verifies ownership before use.
 * - Windows: the named-pipe prefix `\\.\pipe\yantra-`; pipes have no directory.
 */
export function socketsRoot(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return RUN_PIPE_PREFIX;
  const preferred = join(yantraHome(), 'run');
  if (Buffer.byteLength(join(preferred, SOCKET_NAME_SAMPLE)) <= MAX_UNIX_SOCKET_PATH_BYTES) {
    return preferred;
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return join(tmpdir(), `yantra-${uid}`);
}

/** Root of everything the app host owns (FEAT-065): `<data-dir>/ui`, owner-only. */
export function uiRoot(): string {
  return join(dataDir(), 'ui');
}

/** Where the app host writes detached-worker launch and result files. */
export function workerLaunchRoot(): string {
  return join(uiRoot(), 'launch');
}

/** The app host's single-instance lock (`HostLockRecord`, FEAT-065). */
export function uiHostLockPath(): string {
  return join(uiRoot(), 'host.lock');
}

/** The lock every invocation-record mutation runs under (D11 slot invariant). */
export function slotsLockPath(): string {
  return join(uiRoot(), 'slots.lock');
}

/** Directory of app invocation records and their results. */
export function invocationsRoot(): string {
  return join(uiRoot(), 'invocations');
}

/** Callers pass only IDs matching `INVOCATION_ID_PATTERN`, so a path cannot escape. */
function checkedInvocationId(invocationId: string): string {
  if (!/^[A-Za-z0-9_-]{16,64}$/u.test(invocationId)) {
    throw new Error(`Invalid invocation ID: ${JSON.stringify(invocationId.slice(0, 80))}`);
  }
  return invocationId;
}

/** `<data-dir>/ui/invocations/<invocation_id>.json` */
export function invocationPath(invocationId: string): string {
  return join(invocationsRoot(), `${checkedInvocationId(invocationId)}.json`);
}

/** `<data-dir>/ui/invocations/<invocation_id>.result.json`, written once by the worker. */
export function invocationResultPath(invocationId: string): string {
  return join(invocationsRoot(), `${checkedInvocationId(invocationId)}.result.json`);
}

/** The app host's own Pino log (rotated once to `host.log.1`). */
export function hostLogPath(): string {
  return join(uiRoot(), 'host.log');
}

/** The dedicated Chrome/Edge user-data directory of the app window (never an automation profile). */
export function uiChromeProfilePath(): string {
  return join(uiRoot(), 'chrome-profile');
}

/** Returns the path to the doctor diagnostic cache file. */
export function doctorCachePath(): string {
  return join(cacheDir(), 'doctor.json');
}

/**
 * Returns the root of the Yantra-managed browser tree.
 *
 * Every managed binary, the ready pointer, the mutation claim, and the
 * coordination directory live beneath this one directory, so relocating the
 * data directory relocates all of them together.
 */
export function managedBrowsersRoot(): string {
  return join(dataDir(), 'browsers');
}

/** Absolute cache root for exactly one opaque managed-installation child. */
export function managedInstallationRoot(installationId: string): string {
  return join(managedBrowsersRoot(), `installation-${installationId}`);
}

/**
 * Returns the path of the single ready pointer.
 *
 * This file is the whole selection model for managed browsers: a child of the
 * managed root that it does not name is an orphan, never a candidate build.
 */
export function managedReadyPath(): string {
  return join(managedBrowsersRoot(), 'ready.json');
}

/**
 * Returns the path of the exclusive mutation claim.
 *
 * It records the owner and the exact candidate path that owner may write. It
 * is deliberately *not* a phase record — there is no transaction to resume.
 */
export function managedOperationPath(): string {
  return join(managedBrowsersRoot(), 'operation.json');
}

/**
 * Returns the coordination directory holding use reservations and the mutex.
 *
 * It sits outside every child cache so deleting one child can never encompass
 * another child or the coordination state itself.
 */
export function managedCoordinationPath(): string {
  return join(managedBrowsersRoot(), 'coordination');
}

/** Returns the root of the local compatibility evidence cache. */
export function browserCompatibilityCacheRoot(): string {
  return join(cacheDir(), 'browser-compatibility');
}

/** Returns the root directory where workflow YAML files are stored. */
export function workflowsRoot(): string {
  return join(dataDir(), 'workflows');
}

/** Returns the root directory for saved Markdown report templates. */
export function templatesRoot(): string {
  return join(dataDir(), 'templates');
}

/** Shared lock target for validate-then-register schedule operations. */
export function scheduleRegistryLockTarget(): string {
  return join(dataDir(), 'schedules');
}

/** Returns the directory where Yantra configuration files live. */
export function configDir(): string {
  return yantraHome();
}

/** Returns the path to the primary Yantra config file. */
export function configPath(): string {
  return join(yantraHome(), 'config.yaml');
}
