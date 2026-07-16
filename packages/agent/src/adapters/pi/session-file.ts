/**
 * Run-local Pi session placement (FEAT-022 TASK-005, plan §7).
 *
 * The pinned SDK's `SessionManager.create(cwd, sessionDir)` supports creating
 * a new session at an arbitrary directory, so the session JSONL is created
 * **directly** under `<runDir>/agent/` — the plan's relocate-on-close
 * fallback is not needed and is intentionally not implemented. The manifest
 * can always point at the final location because there is no interim one.
 *
 * File hygiene matches existing run-dir handling: the directory is created
 * `0o700` and the session file is chmod-ed `0o600` at finalize (both
 * best-effort no-ops on Windows filesystems without POSIX permissions).
 */

import { existsSync } from 'node:fs';
import { appendFile, chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { SessionManager } from '@earendil-works/pi-coding-agent';

/** Options for {@link createRunLocalSession}. */
export interface RunLocalSessionOptions {
  /** Absolute path of the owning run directory. */
  readonly runDir: string;
  /** Working directory recorded in the session header. */
  readonly cwd: string;
}

/** A Pi session manager pinned to `<runDir>/agent/`. */
export interface RunLocalSession {
  /** The SDK session manager to hand to `createAgentSession`. */
  readonly sessionManager: SessionManager;
  /** `<runDir>/agent` — the final home of the session JSONL. */
  readonly sessionDir: string;
  /**
   * Absolute path of the session JSONL. This is the FINAL location — the
   * seam's `AgentSession.logPath` reports it verbatim.
   */
  logPath(): string;
  /**
   * Finalize the artifact at close: guarantee the JSONL exists (the SDK
   * flushes lazily — a run that never produced an assistant message would
   * otherwise leave no file for the manifest to point at) and apply
   * restrictive permissions.
   */
  finalize(): Promise<void>;
}

/**
 * Create a Pi `SessionManager` whose session file lives under
 * `<runDir>/agent/`.
 *
 * @param options Run directory and working directory.
 * @returns The run-local session handle.
 *
 * Side effects: creates `<runDir>/agent/` (mode `0o700`).
 */
export async function createRunLocalSession(
  options: RunLocalSessionOptions,
): Promise<RunLocalSession> {
  const sessionDir = join(options.runDir, 'agent');
  await mkdir(sessionDir, { recursive: true, mode: 0o700 });

  const sessionManager = SessionManager.create(options.cwd, sessionDir);

  const logPath = (): string => {
    const file = sessionManager.getSessionFile();
    // `newSession()` always assigns a file path when a session directory is
    // set; the fallback keeps `logPath` total if the SDK ever changes that.
    return file ?? join(sessionDir, `${sessionManager.getSessionId()}.jsonl`);
  };

  const finalize = async (): Promise<void> => {
    const file = logPath();
    if (!existsSync(file)) {
      // Lazy flush never fired: persist at least the session header so the
      // run directory always contains a readable session artifact.
      const header = sessionManager.getHeader();
      if (header !== null) {
        await appendFile(file, `${JSON.stringify(header)}\n`, { encoding: 'utf8', mode: 0o600 });
      }
    }
    try {
      await chmod(file, 0o600);
    } catch {
      // chmod is best-effort on Windows and some filesystems.
    }
  };

  return { sessionManager, sessionDir, logPath, finalize };
}
