/**
 * Filesystem-based run store.
 *
 * Manages per-run directories under `runsRoot()/<runId>/`.
 * Implements `RunStore` for use by `RunOrchestrator`.
 */

import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { FailureClass } from '@yantra/protocol';

import { runsRoot } from '../../browser/paths.js';

import { RunDirMissingError } from './errors.js';
import { writeManifest, readManifest } from './manifest-writer.js';
import type { RunManifest, RunRequest, RunStatus, RunStore, RunSummary } from './types.js';

// ---------------------------------------------------------------------------
// Run-id format
// ---------------------------------------------------------------------------

/**
 * Builds a lexicographically sortable run ID.
 *
 * Format: `<isoCompact>-<workflowName>-<shortUUID>`
 * Example: `20260511T091234Z-bank-statement-a7b3`
 */
export function formatRunId(now: Date, workflowName: string, shortUuid: string): string {
  const iso = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  const safeName = workflowName.replace(/[^a-z0-9-]/g, '-').slice(0, 32);
  return `${iso}-${safeName}-${shortUuid}`;
}

function makeShortUuid(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 8);
}

// ---------------------------------------------------------------------------
// LocalRunStore
// ---------------------------------------------------------------------------

export class LocalRunStore implements RunStore {
  private readonly root: string;

  public constructor(root?: string) {
    this.root = root ?? runsRoot();
  }

  /**
   * Creates the run directory + .lock file, returns the canonical runId.
   */
  public async createRun(request: RunRequest): Promise<{ runId: string; runDir: string }> {
    const runId = formatRunId(new Date(), request.workflowName, makeShortUuid());
    const runDir = join(this.root, runId);

    await mkdir(runDir, { recursive: true, mode: 0o700 });

    // Write .lock file with PID and start timestamp
    const lock = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
    await writeFile(join(runDir, '.lock'), lock, { encoding: 'utf8', mode: 0o600 });

    return { runId, runDir };
  }

  /**
   * Lists runs sorted by startedAt descending.
   */
  public async listRuns(opts?: {
    workflowName?: string;
    status?: RunStatus;
    limit?: number;
  }): Promise<readonly RunSummary[]> {
    let entries: string[];
    try {
      entries = await readdir(this.root);
    } catch {
      return [];
    }

    const summaries: RunSummary[] = [];

    await Promise.all(
      entries.map(async (entry) => {
        try {
          const manifest = await readManifest(join(this.root, entry));
          summaries.push({
            runId: manifest.runId,
            workflowName: manifest.workflowName,
            workflowVersion: manifest.workflowVersion,
            status: manifest.status,
            startedAt: manifest.startedAt,
            endedAt: manifest.endedAt,
            durationMs: manifest.durationMs,
            failureClass: manifest.failureClass,
          });
        } catch {
          // Skip entries without a valid manifest.json
        }
      }),
    );

    // Sort descending by startedAt
    summaries.sort((a, b) => b.startedAt.localeCompare(a.startedAt));

    let result = summaries;
    if (opts?.workflowName !== undefined) {
      result = result.filter((s) => s.workflowName === opts.workflowName);
    }
    if (opts?.status !== undefined) {
      result = result.filter((s) => s.status === opts.status);
    }
    const limit = opts?.limit ?? 50;
    return result.slice(0, limit);
  }

  /**
   * Loads a run's manifest. Returns null if not found.
   */
  public async getRun(runId: string): Promise<{ manifest: RunManifest; runDir: string } | null> {
    const runDir = join(this.root, runId);
    try {
      const manifest = await readManifest(runDir);
      return { manifest, runDir };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return null;
      throw err;
    }
  }

  /**
   * Atomically updates status fields on manifest.json.
   */
  public async updateRunStatus(
    runId: string,
    patch: {
      status: RunStatus;
      endedAt?: string;
      failureClass?: FailureClass;
      lastCheckpointStepId?: string;
    },
  ): Promise<void> {
    const runDir = join(this.root, runId);
    let manifest: RunManifest;
    try {
      manifest = await readManifest(runDir);
    } catch {
      throw new RunDirMissingError(runId);
    }

    const updated: RunManifest = {
      ...manifest,
      status: patch.status,
      endedAt: patch.endedAt ?? manifest.endedAt,
      failureClass: patch.failureClass ?? manifest.failureClass,
      durationMs:
        patch.endedAt && manifest.startedAt
          ? new Date(patch.endedAt).getTime() - new Date(manifest.startedAt).getTime()
          : manifest.durationMs,
    };

    await writeManifest(runDir, updated);
  }

  /**
   * Removes the .lock file. Idempotent — no error if already absent.
   */
  public async releaseLock(runId: string): Promise<void> {
    const lockPath = join(this.root, runId, '.lock');
    try {
      await unlink(lockPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw err;
    }
  }
}
