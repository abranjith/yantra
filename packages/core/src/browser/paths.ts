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

/** Returns the directory where Yantra configuration files live. */
export function configDir(): string {
  return yantraHome();
}

/** Returns the path to the primary Yantra config file. */
export function configPath(): string {
  return join(yantraHome(), 'config.yaml');
}
