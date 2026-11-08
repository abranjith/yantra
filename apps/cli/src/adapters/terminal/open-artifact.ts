/**
 * Best-effort cross-platform "open in default app" helper for `--open`.
 *
 * Uses only Node's `child_process` (no new dependency): `start` on Windows,
 * `open` on macOS, `xdg-open` elsewhere. Opening is fire-and-forget and never
 * affects the exit code — a failure here is a warning at most (plan §6).
 */

import { spawn } from 'node:child_process';

/** Command + args that open `target` in the OS default handler. */
export interface OpenerCommand {
  readonly command: string;
  readonly args: readonly string[];
}

/** Injectable dependencies (platform + spawn) for deterministic testing. */
export interface OpenArtifactDeps {
  readonly platform?: NodeJS.Platform;
  readonly spawn?: typeof spawn;
}

/**
 * Resolves the opener command for a platform.
 *
 * @param platform - A `NodeJS.Platform` value.
 * @param target - The file path (or URL) to open.
 * @returns The command and argument vector.
 */
export function openerFor(platform: NodeJS.Platform, target: string): OpenerCommand {
  if (platform === 'win32') {
    // The empty "" is `start`'s title argument, required when the target is quoted.
    return { command: 'cmd', args: ['/c', 'start', '', target] };
  }
  if (platform === 'darwin') {
    return { command: 'open', args: [target] };
  }
  return { command: 'xdg-open', args: [target] };
}

/**
 * Opens `target` in the OS default application, detached and silent.
 *
 * @param target - The file path (typically `brief.html`) to open.
 * @param deps - Optional platform/spawn overrides for testing.
 * @returns `true` if the opener was spawned, `false` if spawning threw.
 */
export function openArtifact(target: string, deps: OpenArtifactDeps = {}): boolean {
  const platform = deps.platform ?? process.platform;
  const spawnFn = deps.spawn ?? spawn;
  const { command, args } = openerFor(platform, target);

  try {
    const child = spawnFn(command, [...args], { detached: true, stdio: 'ignore' });
    child.on('error', () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}
