/**
 * The app host as a supervisor (FEAT-065 TASK-015, plan D1–D6, D11).
 *
 * `command.invoke` launches a run-class or mutating command exactly once, as
 * a detached CLI worker running the same handler and argv as the terminal.
 * The host never executes task logic itself.
 *
 * 1. The invocation is parsed through the registry (FEAT-062); `read`,
 *    `in-process-secure`, `adapter` and `exemption` are refused with the
 *    surface to use instead.
 * 2. A `queued` record is created once per client-generated ID; a repeated
 *    submission returns the current state and never spawns.
 * 3. The dequeue loop (on submit, on finish, on a lease change, and every
 *    2 s) takes queued items first-in first-out through drift review and the
 *    slot reservation, then spawns.
 *
 * `command.cancel` withdraws an item that has not started; a started one is
 * stopped through its run socket (FEAT-064 `stopRun`: cancel, a 10 s grace,
 * identity-verified termination, always reconciliation). A worker with no run
 * is terminated by identity after the grace.
 */

import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import {
  type FileInvocationStore,
  NodeProcessLivenessProbe,
  NodeProcessTreeTerminator,
  invocationResultPath,
  runsRoot,
  stopRun,
  type ProcessLivenessProbe,
  type ProcessTreeTerminator,
} from '@yantra/core';
import {
  CommandInvokeParams,
  EmptyParams,
  InvocationIdParams,
  InvocationSummary,
  QueueListResult,
  QueueStartParams,
  parseInvocation,
  type CommandInvocation,
  type DisplayedEffective,
  type DriftDifference,
  type ExecutionClass,
  type InvocationRecord,
  type WorkerLaunch,
} from '@yantra/protocol';

import { launchFilePath, type SpawnedWorker } from '../../worker/spawn.js';

import { SILENT_HOST_LOGGER, type HostLogger } from './host.js';
import { RpcError, type RpcMethodRegistry } from './rpc-server.js';

/** How often the dequeue loop runs on its own. */
export const DEQUEUE_MS = 2_000;
/** How long a cancelled worker gets before it is terminated. */
export const CANCEL_GRACE_MS = 10_000;

/** Why an execution class is refused, and where to go instead. */
const REFUSALS: Partial<Record<ExecutionClass, (path: string) => [string, string]>> = {
  read: (path) => [
    `${path} is a read; it runs in the host, not as a worker.`,
    `Use read.${path.split(' ').join('.')}.`,
  ],
  'in-process-secure': (path) => [
    `${path} handles a secret and never runs from the app queue.`,
    'Use the Credentials surface (secret.*).',
  ],
  adapter: (path) => [
    `${path} needs an app adapter, and none is registered yet.`,
    'Run it in a terminal.',
  ],
  exemption: (path) => [
    `${path} runs only in a terminal (plan D15).`,
    `Run \`yantra ${path}\` in a terminal.`,
  ],
};

/** Reviews a queued item before it may start (TASK-017); an empty list means no drift. */
export type DriftReview = (record: InvocationRecord) => Promise<readonly DriftDifference[]>;

export interface SupervisorDeps {
  readonly store: FileInvocationStore;
  /** Starts a detached worker for a launch (FEAT-064 `spawnDetachedWorker`). */
  readonly spawn: (launch: WorkerLaunch) => Promise<SpawnedWorker>;
  /** The worker launch directory. */
  readonly launchDir: string;
  /** Sends a notification to every connected window. */
  readonly notify: (method: string, params: Record<string, unknown>) => void;
  readonly logger?: HostLogger;
  readonly now?: () => Date;
  readonly probe?: ProcessLivenessProbe;
  readonly terminator?: ProcessTreeTerminator;
  readonly stop?: typeof stopRun;
  readonly runsRoot?: string;
  readonly drift?: DriftReview;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly cancelGraceMs?: number;
  readonly dequeueMs?: number;
}

/** What `command.invoke` returns. */
export type InvokeResult = InvocationSummary;

/** See the module comment. */
export class Supervisor {
  private readonly logger: HostLogger;
  private readonly now: () => Date;
  private readonly probe: ProcessLivenessProbe;
  private readonly terminator: ProcessTreeTerminator;
  private readonly sleep: (ms: number) => Promise<void>;
  private timer: NodeJS.Timeout | null = null;
  private dequeuing: Promise<void> | null = null;
  private again = false;
  private readonly announcedResults = new Set<string>();

  public constructor(private readonly deps: SupervisorDeps) {
    this.logger = deps.logger ?? SILENT_HOST_LOGGER;
    this.now = deps.now ?? (() => new Date());
    this.probe = deps.probe ?? new NodeProcessLivenessProbe();
    this.terminator = deps.terminator ?? new NodeProcessTreeTerminator();
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Starts the periodic dequeue tick (which also picks up results). */
  public start(): void {
    this.timer ??= setInterval(() => {
      void this.dequeue();
    }, this.deps.dequeueMs ?? DEQUEUE_MS);
    this.timer.unref();
  }

  public stopLoop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** Registers `command.*` and `queue.*`. */
  public register(methods: RpcMethodRegistry): void {
    methods
      .register('command.invoke', {
        params: CommandInvokeParams,
        result: InvocationSummary,
        handler: ({ invocation, displayed_effective: displayed }) =>
          this.invoke(invocation, displayed),
      })
      .register('command.cancel', {
        params: InvocationIdParams,
        result: InvocationSummary,
        handler: ({ invocation_id: id }) => this.cancel(id),
      })
      .register('queue.list', {
        params: EmptyParams,
        result: QueueListResult,
        handler: async () => ({ items: await this.summaries() }),
      })
      .register('queue.start', {
        params: QueueStartParams,
        result: InvocationSummary,
        handler: ({ invocation_id: id, acknowledge_duplicate_risk: acknowledged }) =>
          this.startAgain(id, acknowledged === true),
      })
      .register('queue.discard', {
        params: InvocationIdParams,
        result: InvocationSummary,
        handler: async ({ invocation_id: id }) => {
          const record = await this.require(id);
          if (
            !['queued', 'needs_review', 'never_started', 'start_unknown'].includes(record.state)
          ) {
            throw new RpcError('not_allowed', `This item is ${record.state}; stop it instead.`);
          }
          return this.announce(await this.deps.store.discard(id));
        },
      });
  }

  /** `command.invoke`; see the module comment. */
  public async invoke(
    invocation: CommandInvocation,
    displayed: DisplayedEffective,
  ): Promise<InvokeResult> {
    const parsed = parseInvocation([...invocation.path, ...invocation.argv], {
      cwd: invocation.cwd,
      invocationId: invocation.invocation_id,
    });
    if (!parsed.isOk) {
      throw new RpcError('invalid_params', parsed.error.message, parsed.error.suggestion);
    }
    const execution = parsed.value.execution;
    const refusal = REFUSALS[execution];
    if (refusal !== undefined) {
      const [message, remediation] = refusal(invocation.path.join(' '));
      throw new RpcError('not_allowed', message, remediation);
    }
    const now = this.now().toISOString();
    const { record, created } = await this.deps.store.create({
      schema_version: 1,
      invocation_id: invocation.invocation_id,
      invocation,
      execution_class: execution as 'run' | 'mutate' | 'exclusive',
      state: 'queued',
      queued_at: now,
      updated_at: now,
      displayed_effective: displayed,
      run_id: null,
      worker: null,
      review: null,
      result: null,
    });
    if (!created) return this.current(record);
    this.logger.info(
      { invocation_id: record.invocation_id, path: invocation.path.join(' '), class: execution },
      'invocation queued',
    );
    this.announce(record);
    await this.dequeue();
    return this.current(record);
  }

  /** Announces a record changed by review, runs the queue, and returns its summary. */
  public async reviewed(record: InvocationRecord): Promise<InvokeResult> {
    this.announce(record);
    await this.dequeue();
    return this.current(record);
  }

  /** Runs the dequeue loop once (concurrent calls coalesce). */
  public async dequeue(): Promise<void> {
    if (this.dequeuing !== null) {
      this.again = true;
      return this.dequeuing;
    }
    this.dequeuing = this.dequeueOnce()
      .catch((error: unknown) => {
        this.logger.warn(
          { reason: error instanceof Error ? error.name : 'unknown' },
          'dequeue failed',
        );
      })
      .finally(() => {
        this.dequeuing = null;
      });
    await this.dequeuing;
    if (this.again) {
      this.again = false;
      await this.dequeue();
    }
  }

  /** `command.cancel`; see the module comment. */
  public async cancel(invocationId: string): Promise<InvokeResult> {
    const record = await this.require(invocationId);
    switch (record.state) {
      case 'queued':
      case 'needs_review':
      case 'never_started':
      case 'start_unknown':
      case 'reserved':
        return this.announce(await this.deps.store.discard(invocationId));
      case 'spawning':
        // The worker's claim will be refused.
        return this.announce(await this.deps.store.markNeverStarted(invocationId));
      case 'claimed':
      case 'running':
        void this.stopStarted(record);
        return this.summary(record);
      case 'finished':
      case 'discarded':
        return this.summary(record);
    }
  }

  private async startAgain(invocationId: string, acknowledged: boolean): Promise<InvokeResult> {
    const record = await this.require(invocationId);
    if (record.state === 'start_unknown' && !acknowledged) {
      throw new RpcError(
        'needs_confirmation',
        'The earlier start of this item is unknown: it may already have run, so starting it again may repeat its effects.',
        'Send queue.start again with acknowledge_duplicate_risk: true to start it anyway.',
      );
    }
    if (record.state !== 'never_started' && record.state !== 'start_unknown') {
      throw new RpcError(
        'not_allowed',
        `This item is ${record.state}; only one that did not start can start again.`,
      );
    }
    const requeued = await this.deps.store.requeue(invocationId, {
      acknowledgeDuplicateRisk: acknowledged,
    });
    this.announce(requeued);
    await this.dequeue();
    return this.current(requeued);
  }

  private async dequeueOnce(): Promise<void> {
    const records = await this.deps.store.list();
    for (const record of records) this.pickUpResult(record);
    for (const record of records.filter((item) => item.state === 'queued')) {
      const differences = (await this.deps.drift?.(record)) ?? [];
      if (differences.length > 0) {
        this.announce(await this.deps.store.setReview(record.invocation_id, differences));
        this.logger.info(
          { invocation_id: record.invocation_id, count: differences.length },
          'drift review',
        );
        continue;
      }
      const outcome = await this.deps.store.reserve(record.invocation_id, (item) =>
        item.invocation.path[0] === 'resume' ? (item.invocation.argv[0] ?? null) : null,
      );
      if (!outcome.reserved) continue;
      this.announce(outcome.record);
      await this.spawn(outcome.record);
    }
  }

  private async spawn(record: InvocationRecord): Promise<void> {
    const id = record.invocation_id;
    const spawning = await this.deps.store.markSpawning(id);
    this.announce(spawning);
    // A retried item reuses its ID; the host owns the launch directory.
    await rm(launchFilePath(this.deps.launchDir, id), { force: true });
    try {
      const worker = await this.deps.spawn({
        schema_version: 1,
        invocation: record.invocation,
        ...(record.run_id === null ? {} : { run_id: record.run_id }),
        result_path: invocationResultPath(id),
      });
      this.logger.info({ invocation_id: id, worker_pid: worker.pid }, 'worker spawned');
    } catch (error) {
      // The trampoline may or may not have started the worker.
      const next = await this.deps.store.markStartUnknown(id).catch(() => null);
      if (next !== null) this.announce(next);
      this.logger.warn(
        { invocation_id: id, reason: error instanceof Error ? error.name : 'unknown' },
        'spawn failed',
      );
    }
  }

  private async stopStarted(record: InvocationRecord): Promise<void> {
    const graceMs = this.deps.cancelGraceMs ?? CANCEL_GRACE_MS;
    if (record.run_id !== null) {
      await (this.deps.stop ?? stopRun)(
        { runDir: join(this.deps.runsRoot ?? runsRoot(), record.run_id), graceMs },
        { probe: this.probe, terminator: this.terminator },
      ).catch(() => undefined);
    } else if (record.worker !== null) {
      // No run socket (a mutate command): give it the grace period, then end it by identity.
      await this.sleep(graceMs);
      const identity = { pid: record.worker.pid, startToken: record.worker.start_token };
      if ((await this.probe.check(identity)) === 'alive')
        await this.terminator.terminate(identity.pid);
    }
    const current = await this.deps.store.get(record.invocation_id);
    if (current !== null && (current.state === 'claimed' || current.state === 'running')) {
      const alive =
        current.worker === null
          ? 'dead'
          : await this.probe.check({
              pid: current.worker.pid,
              startToken: current.worker.start_token,
            });
      if (alive === 'dead') {
        this.announce(
          await this.deps.store.finish(current.invocation_id, {
            exitCode: 130,
            reason: 'owner_lost',
          }),
        );
      }
    }
    await this.dequeue();
  }

  /** Announces a written result once. */
  private pickUpResult(record: InvocationRecord): void {
    if (this.announcedResults.has(record.invocation_id)) return;
    if (!['claimed', 'running', 'finished'].includes(record.state)) return;
    void this.deps.store.readResult(record.invocation_id).then((result) => {
      if (result === null || this.announcedResults.has(record.invocation_id)) return;
      this.announcedResults.add(record.invocation_id);
      this.deps.notify('invocation.result', {
        invocation_id: record.invocation_id,
        outcome: result.outcome,
      });
    });
  }

  private announce(record: InvocationRecord): InvokeResult {
    const summary = this.summary(record);
    this.deps.notify('invocation.changed', summary);
    this.logger.info(
      { invocation_id: record.invocation_id, state: record.state, run_id: record.run_id },
      'invocation changed',
    );
    return summary;
  }

  private summary(record: InvocationRecord, position?: number): InvokeResult {
    return {
      invocation_id: record.invocation_id,
      state: record.state,
      execution_class: record.execution_class,
      path: [...record.invocation.path],
      ...(position === undefined ? {} : { position }),
      run_id: record.run_id,
      queued_at: record.queued_at,
      review: record.review,
      result: record.result,
    };
  }

  private async summaries(): Promise<InvokeResult[]> {
    const records = await this.deps.store.list();
    let position = 0;
    return records.map((record) => {
      const waiting = record.state === 'queued' && record.execution_class !== 'mutate';
      if (waiting) position += 1;
      return this.summary(record, waiting ? position : undefined);
    });
  }

  /** The latest summary of `record`, with its queue position while queued. */
  private async current(record: InvocationRecord): Promise<InvokeResult> {
    const latest = (await this.summaries()).find(
      (item) => item.invocation_id === record.invocation_id,
    );
    return latest ?? this.summary(record);
  }

  private async require(id: string): Promise<InvocationRecord> {
    const record = await this.deps.store.get(id);
    if (record === null) throw new RpcError('not_found', `There is no queued item ${id}.`);
    return record;
  }
}
