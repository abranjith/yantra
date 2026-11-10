/**
 * Filesystem-based run store.
 *
 * Manages per-run directories under `runsRoot()/<runId>/`.
 * Implements `RunStore` for use by `RunOrchestrator`.
 */

import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  FailureClass,
  RunLeaseOrigin,
  TaskOutcome,
  TerminationReason,
} from '@yantra/protocol';

import { MarkdownReportBuilder } from '../../audit/report-builder.js';
import { runsRoot } from '../../browser/paths.js';
import type { Logger } from '../../browser/types.js';
import { openTaskEventBus } from '../../run-events/mirroring-event-bus.js';
import type { RunEventStream } from '../../run-events/stream.js';
import {
  RunOwnershipSession,
  type ClaimRunLease,
  type RunOwnershipSessionOptions,
} from '../../run-ownership/ownership-session.js';
import { claimExistingRun } from '../../run-ownership/takeover.js';

import { RunDirMissingError } from './errors.js';
import { writeManifest, readManifest } from './manifest-writer.js';
import type {
  AgentRunRequest,
  AgentRunStore,
  AgentStartupFailure,
  RunManifest,
  RunRequest,
  RunStatus,
  RunStore,
  RunSummary,
} from './types.js';

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

/** Seams for the ownership session each run directory gets (tests). */
export interface LocalRunStoreOptions {
  readonly logger?: Logger;
  /** Overrides how a session is opened (tests inject a fake socket). */
  readonly openSession?: (options: RunOwnershipSessionOptions) => Promise<RunOwnershipSession>;
}

export class LocalRunStore implements RunStore, AgentRunStore {
  private readonly root: string;
  private readonly sessions = new Map<string, RunOwnershipSession>();
  private readonly options: LocalRunStoreOptions;

  public constructor(root?: string, options: LocalRunStoreOptions = {}) {
    this.root = root ?? runsRoot();
    this.options = options;
  }

  /**
   * Creates the run directory and claims it (`lease.json` plus the run
   * socket), returning the canonical runId.
   */
  public async createRun(request: RunRequest): Promise<{ runId: string; runDir: string }> {
    return this.createRunDirectory(request.workflowName, {
      command: ['run'],
      origin: request.receipt?.invoked_by ?? 'terminal',
    });
  }

  /**
   * Creates an agentic run and its initial manifest before model, provider, or
   * credential validation begins.
   *
   * @param request Stable command/task metadata and any already-resolved,
   *   non-secret agent metadata.
   * @returns The single canonical run identity and directory for the attempt.
   */
  public async createAgentRun(
    request: AgentRunRequest,
  ): Promise<{ runId: string; runDir: string }> {
    const { runId, runDir } = await this.createRunDirectory(request.command, {
      command: [request.command],
      origin: request.origin ?? 'terminal',
    });
    const startedAt = new Date().toISOString();
    const manifest: RunManifest = {
      runId,
      taskId: request.taskId,
      workflowName: request.command,
      workflowVersion: null,
      params: {},
      startedAt,
      endedAt: undefined,
      status: 'running',
      durationMs: undefined,
      failureClass: undefined,
      profileKind: 'ephemeral',
      cookieProfilePath: null,
      outputBindingNames: [],
      chromeDriftWarning: undefined,
      runKind: 'agentic',
      ...(request.partialAgent === undefined ? {} : { agent: request.partialAgent }),
      ...(request.template === undefined ? {} : { template: request.template }),
    };
    await writeManifest(runDir, manifest);
    return { runId, runDir };
  }

  /**
   * Finalizes an agentic startup failure as a normal auditable run.
   *
   * @param runId Existing run created by {@link createAgentRun}.
   * @param error Typed, sanitized provider startup failure.
   * @param runEvents The run's open event stream, if any: `task_failed` is
   *   mirrored into it (the caller records the outcome).
   * @returns Nothing after manifest, event, report, and lock state are durable.
   */
  public async finalizeStartupFailure(
    runId: string,
    error: AgentStartupFailure,
    runEvents?: RunEventStream,
  ): Promise<void> {
    const runDir = join(this.root, runId);
    let manifest: RunManifest;
    try {
      manifest = await readManifest(runDir);
    } catch {
      throw new RunDirMissingError(runId);
    }

    const endedAt = new Date().toISOString();
    const updated: RunManifest = {
      ...manifest,
      status: 'failed',
      endedAt,
      durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(manifest.startedAt)),
      failureClass: 'unexpected',
      agentError: { ...error, at: endedAt },
    };
    await writeManifest(runDir, updated);

    const events = openTaskEventBus(runDir, runEvents?.opened === true ? runEvents : null);
    events.publish({
      task_id: manifest.taskId,
      at: endedAt,
      kind: 'task_failed',
      failure_class: 'unexpected',
      report_path: 'report.md',
    });
    await events.close();

    const report = new MarkdownReportBuilder();
    await report.build(runDir, 'failed', {
      failureClass: error.code,
      message: error.message,
    });
    // The failure manifest and its event are durable above (FEAT-064 order).
    await this.releaseOwnership(runId);
  }

  /**
   * Creates the run directory and claims it before any manifest exists, so a
   * `running` manifest always has a lease behind it (FEAT-064).
   */
  private async createRunDirectory(
    name: string,
    ownership: { readonly command: readonly string[]; readonly origin: RunLeaseOrigin },
  ): Promise<{ runId: string; runDir: string }> {
    const runId = formatRunId(new Date(), name, makeShortUuid());
    const runDir = join(this.root, runId);

    await mkdir(runDir, { recursive: true, mode: 0o700 });
    await this.openSession(runId, runDir, ownership);
    return { runId, runDir };
  }

  private async openSession(
    runId: string,
    runDir: string,
    ownership: {
      readonly command: readonly string[];
      readonly origin: RunLeaseOrigin;
      readonly claim?: ClaimRunLease;
    },
  ): Promise<RunOwnershipSession> {
    const open = this.options.openSession ?? ((options) => RunOwnershipSession.open(options));
    const session = await open({
      runDir,
      runId,
      origin: ownership.origin,
      executionClass: 'run',
      command: ownership.command,
      ...(ownership.claim === undefined ? {} : { claim: ownership.claim }),
      ...(this.options.logger === undefined ? {} : { logger: this.options.logger }),
    });
    this.sessions.set(runId, session);
    return session;
  }

  /** The run's ownership session while this process owns it. */
  public ownership(runId: string): RunOwnershipSession | undefined {
    return this.sessions.get(runId);
  }

  /**
   * Takes ownership of an existing run directory for `resume`: a dead
   * owner's run is reconciled first, then its lease replaced (FEAT-064).
   *
   * @throws RunLeaseHeldError when an owner that is alive, or cannot be
   *   verified, holds the run.
   */
  public async acquireOwnership(
    runId: string,
    init: { readonly command: readonly string[]; readonly origin?: RunLeaseOrigin },
  ): Promise<RunOwnershipSession> {
    const existing = this.sessions.get(runId);
    if (existing !== undefined) return existing;
    return this.openSession(runId, join(this.root, runId), {
      command: init.command,
      origin: init.origin ?? 'terminal',
      claim: (runDir, claimInit, deps) =>
        claimExistingRun(runDir, claimInit, {
          ...deps,
          ...(this.options.logger === undefined ? {} : { logger: this.options.logger }),
        }),
    });
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
          if (!hasListableRunMetadata(manifest)) {
            return;
          }
          summaries.push({
            runId: manifest.runId,
            workflowName: manifest.workflowName,
            workflowVersion: manifest.workflowVersion,
            status: manifest.status,
            startedAt: manifest.startedAt,
            endedAt: manifest.endedAt,
            durationMs: manifest.durationMs,
            failureClass: manifest.failureClass,
            ...(manifest.taskOutcome === undefined ? {} : { taskOutcome: manifest.taskOutcome }),
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
      taskOutcome?: TaskOutcome;
      terminationReason?: TerminationReason;
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
      ...(patch.taskOutcome === undefined ? {} : { taskOutcome: patch.taskOutcome }),
      ...(patch.terminationReason === undefined
        ? {}
        : { terminationReason: patch.terminationReason }),
      durationMs:
        patch.endedAt && manifest.startedAt
          ? new Date(patch.endedAt).getTime() - new Date(manifest.startedAt).getTime()
          : manifest.durationMs,
    };

    await writeManifest(runDir, updated);
  }

  /**
   * Ends ownership: drains and closes the run socket, then removes
   * `lease.json`. Call only after the terminal event and terminal manifest are
   * flushed. Idempotent; a run this store never owned is left alone.
   */
  public async releaseOwnership(runId: string): Promise<void> {
    const session = this.sessions.get(runId);
    if (session === undefined) return;
    this.sessions.delete(runId);
    await session.finish();
  }
}

/**
 * Run directories are shared with historical task artifacts whose
 * `manifest.json` uses a different schema. Only workflow run manifests belong
 * in this store's listing.
 */
function hasListableRunMetadata(manifest: RunManifest): boolean {
  return (
    typeof manifest.runId === 'string' &&
    typeof manifest.workflowName === 'string' &&
    typeof manifest.startedAt === 'string'
  );
}
