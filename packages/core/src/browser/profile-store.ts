import { randomUUID } from 'node:crypto';
import { access, chmod, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import { ProfilePathRefusedError } from './errors.js';
import { dataDir, ephemeralRoot } from './paths.js';
import type {
  Logger,
  ProfileSpec,
  ProfileStore,
  ResolvedProfile,
  WorkflowProfileEntry,
} from './types.js';

/** Regex for valid workflow names: lowercase alphanumeric + hyphens/underscores, 1-64 chars. */
const WORKFLOW_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * Real Chrome profile roots that must never be used as Yantra profile paths.
 * Writing a Yantra profile here could corrupt the user's browser data.
 */
function forbiddenProfileRoots(): readonly string[] {
  const home = homedir();
  const roots: string[] = [
    // macOS
    join(home, 'Library', 'Application Support', 'Google', 'Chrome'),
    join(home, 'Library', 'Application Support', 'Chromium'),
    // Linux
    join(home, '.config', 'google-chrome'),
    join(home, '.config', 'chromium'),
  ];

  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData || process.platform === 'win32') {
    const base = localAppData ?? join(home, 'AppData', 'Local');
    roots.push(join(base, 'Google', 'Chrome', 'User Data'), join(base, 'Chromium', 'User Data'));
  }

  return roots;
}

/**
 * Guard: throws ProfilePathRefusedError if `p` is at or inside a real Chrome profile dir.
 */
function assertNotInsideRealChromeProfile(p: string): void {
  const resolved = resolve(p);
  for (const root of forbiddenProfileRoots()) {
    const resolvedRoot = resolve(root);
    if (
      resolved === resolvedRoot ||
      resolved.startsWith(resolvedRoot + '/') ||
      resolved.startsWith(resolvedRoot + '\\')
    ) {
      throw new ProfilePathRefusedError({
        path: p,
        reason: `Path is inside a real Chrome profile dir (${root}). Yantra refuses to write there to protect your browser data.`,
      });
    }
  }
}

async function ensureDirWithPerms(dirPath: string): Promise<boolean> {
  let createdNow = false;
  try {
    await access(dirPath);
  } catch {
    await mkdir(dirPath, { recursive: true, mode: 0o700 });
    createdNow = true;
  }

  if (process.platform !== 'win32') {
    try {
      await chmod(dirPath, 0o700);
    } catch {
      // best-effort; we'll detect bad perms in doctor
    }
  }

  return createdNow;
}

/**
 * Manages Chrome profile directories for Yantra workflows.
 * Enforces 0700 permissions on Unix, best-effort on Windows.
 */
export class LocalProfileStore implements ProfileStore {
  private readonly logger: Logger | undefined;

  constructor(deps?: { logger?: Logger }) {
    this.logger = deps?.logger;
  }

  /**
   * Resolves a ProfileSpec to a concrete, writable directory.
   *
   * @throws {ProfilePathRefusedError} when path is inside a real Chrome profile
   */
  async resolve(spec: ProfileSpec): Promise<ResolvedProfile> {
    switch (spec.kind) {
      case 'workflow': {
        const { workflowName } = spec;
        if (!WORKFLOW_NAME_RE.test(workflowName)) {
          throw new ProfilePathRefusedError({
            path: workflowName,
            reason: `Invalid workflow name "${workflowName}". Must match /^[a-z0-9][a-z0-9_-]{0,63}$/`,
          });
        }
        const targetPath = join(dataDir(), 'profiles', workflowName);
        assertNotInsideRealChromeProfile(targetPath);
        const createdNow = await ensureDirWithPerms(targetPath);
        return { absolutePath: targetPath, kind: 'workflow', createdNow };
      }

      case 'ephemeral': {
        const targetPath = join(ephemeralRoot(), `yantra-${randomUUID()}`);
        await mkdir(targetPath, { recursive: true, mode: 0o700 });
        return { absolutePath: targetPath, kind: 'ephemeral', createdNow: true };
      }

      case 'explicit': {
        const targetPath = spec.absolutePath;
        if (!isAbsolute(targetPath)) {
          throw new ProfilePathRefusedError({
            path: targetPath,
            reason: 'Explicit profile path must be absolute',
          });
        }
        assertNotInsideRealChromeProfile(targetPath);

        // Validate exists, is a directory, and is writable
        await access(targetPath);
        const info = await stat(targetPath);
        if (!info.isDirectory()) {
          throw new ProfilePathRefusedError({
            path: targetPath,
            reason: 'Path is not a directory',
          });
        }

        if (process.platform !== 'win32') {
          const mode = info.mode & 0o777;
          if (mode & 0o077) {
            this.logger?.warn(
              { path: targetPath, mode: mode.toString(8) },
              'Explicit profile dir has group/other permissions; expected 0700',
            );
          }
        }

        return { absolutePath: targetPath, kind: 'explicit', createdNow: false };
      }
    }
  }

  /** Lists all persistent workflow profiles on disk, sorted by lastModified descending. */
  async listWorkflowProfiles(): Promise<readonly WorkflowProfileEntry[]> {
    const root = join(dataDir(), 'profiles');
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      return [];
    }

    const results: WorkflowProfileEntry[] = [];
    for (const name of entries) {
      try {
        const p = join(root, name);
        const info = await stat(p);
        if (info.isDirectory()) {
          results.push({
            workflowName: name,
            absolutePath: p,
            sizeBytes: info.size,
            lastModified: info.mtime.toISOString(),
          });
        }
      } catch {
        // skip entries we can't stat
      }
    }

    return results.sort(
      (a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime(),
    );
  }

  /** Removes a workflow's persistent profile directory. Idempotent. */
  async removeWorkflowProfile(workflowName: string): Promise<void> {
    if (!WORKFLOW_NAME_RE.test(workflowName)) {
      throw new ProfilePathRefusedError({
        path: workflowName,
        reason: `Invalid workflow name "${workflowName}"`,
      });
    }
    const targetPath = join(dataDir(), 'profiles', workflowName);
    await rm(targetPath, { recursive: true, force: true });
  }

  /**
   * Best-effort cleanup of an ephemeral profile directory.
   * Never throws — EBUSY is logged as warn (Chrome may still hold a lock on Windows).
   */
  async cleanupEphemeral(absolutePath: string): Promise<void> {
    try {
      await rm(absolutePath, { recursive: true, force: true });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EBUSY' || code === 'EPERM') {
        this.logger?.warn(
          { path: absolutePath, code },
          'Could not clean ephemeral profile dir (Chrome may still hold a lock); will be cleaned on next run',
        );
      }
      // All other errors are silently swallowed — cleanup is best-effort
    }
  }
}
