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
