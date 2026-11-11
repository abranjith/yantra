/**
 * The first module the app runs (FEAT-065 TASK-011, plan §7).
 *
 * `yantra ui` opens `/#code=<launch code>`. This module reads the code,
 * removes it from the address bar and history with `history.replaceState`
 * **before any other module runs**, and keeps it in a module-local variable
 * that {@link takeLaunchCode} hands out exactly once. The code never reaches
 * storage, a request URL or a log.
 */

let launchCode: string | null = null;

/** Reads `#code=…` from `hash`, or null. */
export function parseLaunchFragment(hash: string): string | null {
  const fragment = hash.startsWith('#') ? hash.slice(1) : hash;
  const value = new URLSearchParams(fragment).get('code');
  return value !== null && /^[A-Za-z0-9_-]{16,128}$/u.test(value) ? value : null;
}

/**
 * Moves a launch code from the URL into memory and scrubs the URL. Runs at
 * import; exported so tests can run it against a prepared location.
 */
export function captureLaunchCode(
  location: Pick<Location, 'hash' | 'pathname' | 'search'>,
  history: Pick<History, 'replaceState'>,
): void {
  if (location.hash.length === 0) return;
  launchCode = parseLaunchFragment(location.hash);
  history.replaceState(null, '', `${location.pathname}${location.search}`);
}

/** The launch code, once; later calls return null. */
export function takeLaunchCode(): string | null {
  const code = launchCode;
  launchCode = null;
  return code;
}

captureLaunchCode(window.location, window.history);
