import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Returns the Yantra data root directory.
 * Honors XDG_DATA_HOME on Linux/macOS; uses %LOCALAPPDATA%\yantra on Windows.
 *
 * @example dataDir() // → "/home/user/.local/share/yantra" on Linux
 */
export function dataDir(): string {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
    return join(base, 'yantra');
  }
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg) return join(xdg, 'yantra');
  return join(homedir(), '.local', 'share', 'yantra');
}

/**
 * Returns the Yantra cache root directory.
 * Honors XDG_CACHE_HOME on Linux/macOS; uses %LOCALAPPDATA%\yantra\Cache on Windows.
 *
 * @example cacheDir() // → "/home/user/.cache/yantra" on Linux
 */
export function cacheDir(): string {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
    return join(base, 'yantra', 'Cache');
  }
  const xdg = process.env.XDG_CACHE_HOME;
  if (xdg) return join(xdg, 'yantra');
  return join(homedir(), '.cache', 'yantra');
}

/**
 * Returns the root directory where per-workflow Chrome profiles are stored.
 *
 * @example profilesRoot() // → "/home/user/.local/share/yantra/profiles"
 */
export function profilesRoot(): string {
  return join(dataDir(), 'profiles');
}

/**
 * Returns the directory where ephemeral profile dirs are created.
 * Ephemeral profiles live in the OS temp directory.
 */
export function ephemeralRoot(): string {
  return tmpdir();
}

/**
 * Returns the root directory where per-run artifacts are stored.
 *
 * @example runsRoot() // → "/home/user/.local/share/yantra/runs"
 */
export function runsRoot(): string {
  return join(dataDir(), 'runs');
}

/**
 * Returns the path to the doctor diagnostic cache file.
 *
 * @example doctorCachePath() // → "/home/user/.cache/yantra/doctor.json"
 */
export function doctorCachePath(): string {
  return join(cacheDir(), 'doctor.json');
}

/**
 * Returns the root directory where workflow YAML files are stored.
 *
 * @example workflowsRoot() // → "/home/user/.local/share/yantra/workflows"
 */
export function workflowsRoot(): string {
  return join(dataDir(), 'workflows');
}

/**
 * Returns the root directory for saved Markdown report templates.
 *
 * @example templatesRoot() // â†’ "/home/user/.local/share/yantra/templates"
 */
export function templatesRoot(): string {
  return join(dataDir(), 'templates');
}

/**
 * Returns the directory where Yantra configuration files live.
 *
 * Honors XDG_CONFIG_HOME on Linux/macOS; uses %APPDATA%/yantra on Windows.
 *
 * @example configDir() // → "/home/user/.config/yantra"
 */
export function configDir(): string {
  if (process.platform === 'win32') {
    const base = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
    return join(base, 'yantra');
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return join(xdg, 'yantra');
  return join(homedir(), '.config', 'yantra');
}

/**
 * Returns the path to the primary Yantra config file.
 *
 * @example configPath() // → "/home/user/.config/yantra/config.yaml"
 */
export function configPath(): string {
  return join(configDir(), 'config.yaml');
}
