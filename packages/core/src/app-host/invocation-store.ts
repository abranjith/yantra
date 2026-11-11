/**
 * Launch ownership for app invocations (FEAT-065 TASK-014, plan D11).
 *
 * One file per invocation, `<data-dir>/ui/invocations/<id>.json`, created
 * exclusively: a repeated submission of the same client-generated ID returns
 * the existing record instead of launching twice.
 *
 * Every mutation runs under `slots.lock` (a bounded 2 s wait, then
 * {@link SlotLockBusyError}; never a silent write) and is published
 * atomically. Under that lock the slot invariant holds: at most two `run`
 * invocations are `reserved | spawning | claimed | running`; an `exclusive`
 * one is admitted only with none, and blocks new runs while active; `mutate`
 * holds no slot.
 *
 * Only the worker writes `worker`, through {@link FileInvocationStore.claim}.
 * A claim on a withdrawn invocation (`never_started`, `discarded`) throws
 * {@link ClaimRefusedError}, so a late worker exits with no side effects.
 */

import { mkdir, readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import {
  InvocationRecord,
  InvocationResult,
  MAX_INVOCATION_ENVELOPE_BYTES,
  type CommandResultMessage,
  type DriftDifference,
  type InvocationFinishReason,
  type InvocationRecordInput,
  type InvocationState,
} from '@yantra/protocol';
import lockfile from 'proper-lockfile';

import type { ProcessIdentity } from '../browser/installation-types.js';
import {
  invocationPath,
  invocationResultPath,
  invocationsRoot,
  slotsLockPath,
} from '../browser/paths.js';
import { writeFileAtomic } from '../fs/atomic-write.js';

import { ClaimRefusedError, InvalidInvocationTransition, SlotLockBusyError } from './errors.js';

/**
 * The closed transition table (D11). Any other move throws
 * {@link InvalidInvocationTransition}. `reserved → claimed` and
 * `spawning → claimed` happen only through the worker's claim.
 */
export const INVOCATION_TRANSITIONS: Readonly<Record<InvocationState, readonly InvocationState[]>> =
  {
    queued: ['reserved', 'needs_review', 'discarded'],
    needs_review: ['queued', 'discarded'],
    reserved: ['spawning', 'claimed', 'never_started', 'discarded'],
    spawning: ['claimed', 'never_started', 'start_unknown'],
    claimed: ['running', 'finished'],
    running: ['finished'],
    never_started: ['queued', 'discarded'],
    start_unknown: ['queued', 'discarded'],
    finished: [],
    discarded: [],
  };

/** States that hold (or are about to hold) a slot. */
export const ACTIVE_STATES: ReadonlySet<InvocationState> = new Set([
  'reserved',
  'spawning',
  'claimed',
  'running',
]);

/** Run invocations allowed to hold a slot at once. */
export const RUN_SLOTS = 2;

/** True when `from → to` is in the table. */
export function canTransition(from: InvocationState, to: InvocationState): boolean {
  return INVOCATION_TRANSITIONS[from].includes(to);
}

/** Orders records first-in, first-out: `queued_at`, then ID. */
export function fifo(a: InvocationRecord, b: InvocationRecord): number {
  return a.queued_at === b.queued_at
    ? a.invocation_id.localeCompare(b.invocation_id)
    : a.queued_at.localeCompare(b.queued_at);
}

/** Replaces an envelope over 1 MiB with `{truncated, bytes}`. */
export function capResultEnvelope(outcome: CommandResultMessage): CommandResultMessage {
  if (outcome.type !== 'result' || outcome.envelope === null) return outcome;
  const bytes = Buffer.byteLength(JSON.stringify(outcome.envelope), 'utf8');
  return bytes <= MAX_INVOCATION_ENVELOPE_BYTES
    ? outcome
    : { ...outcome, envelope: { truncated: true, bytes } };
}

const WINDOWS_REPLACE_CODES: ReadonlySet<string> = new Set(['EPERM', 'EACCES', 'EBUSY']);

/**
 * Replaces a record atomically. On Windows a scanner or reader can hold the
 * just-written file past `writeFileAtomic`'s own short retry, so the store
 * keeps retrying for up to about 2 s before failing the transition.
 */
async function publishWithRetry(path: string, data: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await writeFileAtomic(path, data, { mode: 0o600 });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (process.platform !== 'win32' || !WINDOWS_REPLACE_CODES.has(code) || attempt >= 8) {
        throw error;
      }
      await delay(50 * (attempt + 1));
    }
  }
}

/** The outcome of {@link FileInvocationStore.reserve}. */
export type ReserveOutcome =
  | { readonly reserved: true; readonly record: InvocationRecord }
  | { readonly reserved: false; readonly position: number; readonly record: InvocationRecord };

export interface InvocationStoreOptions {
  /** Directory of records (defaults to `invocationsRoot()`). */
  readonly root?: string;
  /** The slot lock target (defaults to `slotsLockPath()`). */
  readonly lockPath?: string;
  readonly now?: () => Date;
  /** How long to wait for `slots.lock` before {@link SlotLockBusyError}. */
  readonly lockWaitMs?: number;
  /** `proper-lockfile` seam. */
  readonly lock?: typeof lockfile.lock;
}

const LOCK_POLL_MS = 25;
const LOCK_STALE_MS = 10_000;

/** See the module comment. */
export class FileInvocationStore {
  private readonly root: string;
  private readonly lockPath: string;
  private readonly now: () => Date;
  private readonly lockWaitMs: number;
  private readonly lock: typeof lockfile.lock;

  public constructor(options: InvocationStoreOptions = {}) {
    this.root = options.root ?? invocationsRoot();
    this.lockPath = options.lockPath ?? slotsLockPath();
    this.now = options.now ?? (() => new Date());
    this.lockWaitMs = options.lockWaitMs ?? 2_000;
    this.lock = options.lock ?? lockfile.lock;
  }

  /**
   * Creates a `queued` record, once. When the ID already exists, the existing
   * record is returned unchanged (`created: false`).
   *
   * Uniqueness comes from `slots.lock`: the existence check and the publish
   * happen under it. The record is published by rename, not by an exclusive
   * hard link, because on Windows a hard-linked file cannot be replaced by a
   * later rename for seconds (EPERM), and records are rewritten on every
   * transition.
   */
  public async create(
    input: InvocationRecordInput,
  ): Promise<{ readonly record: InvocationRecord; readonly created: boolean }> {
    const record = InvocationRecord.parse(input);
    return this.withLock(async () => {
      const existing = await this.get(record.invocation_id);
      if (existing !== null) return { record: existing, created: false };
      await publishWithRetry(this.pathOf(record.invocation_id), this.serialize(record));
      return { record, created: true };
    });
  }

  /** The record, or null. A corrupt file reads as null. */
  public async get(invocationId: string): Promise<InvocationRecord | null> {
    let raw: string;
    try {
      raw = await readFile(this.pathOf(invocationId), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    try {
      const parsed = InvocationRecord.safeParse(JSON.parse(raw) as unknown);
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  /** Every readable record, first-in first-out. */
  public async list(): Promise<InvocationRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const ids = names
      .filter((name) => name.endsWith('.json') && !name.endsWith('.result.json'))
      .map((name) => name.slice(0, -'.json'.length))
      .filter((id) => /^[A-Za-z0-9_-]{16,64}$/u.test(id));
    const records = await Promise.all(ids.map((id) => this.get(id)));
    return records.filter((record): record is InvocationRecord => record !== null).sort(fifo);
  }

  /**
   * Moves `queued → reserved` when the slot invariant and FIFO order allow
   * it, allocating the run ID (the existing one for `resume`). Otherwise
   * returns the item's 1-based position among queued slot-holding items.
   */
  public async reserve(
    invocationId: string,
    allocateRunId: (record: InvocationRecord) => string | null,
  ): Promise<ReserveOutcome> {
    return this.withLock(async () => {
      const record = await this.require(invocationId);
      if (record.state !== 'queued') {
        throw new InvalidInvocationTransition(invocationId, record.state, 'reserved');
      }
      const all = await this.list();
      const active = all.filter((item) => ACTIVE_STATES.has(item.state));
      const activeRuns = active.filter((item) => item.execution_class === 'run').length;
      const activeExclusive = active.some((item) => item.execution_class === 'exclusive');
      const waiting = all.filter(
        (item) => item.state === 'queued' && item.execution_class !== 'mutate',
      );
      const position = waiting.findIndex((item) => item.invocation_id === invocationId) + 1;
      const admitted =
        record.execution_class === 'mutate'
          ? true
          : position === 1 &&
            !activeExclusive &&
            (record.execution_class === 'run' ? activeRuns < RUN_SLOTS : activeRuns === 0);
      if (!admitted) return { reserved: false, position: Math.max(position, 1), record };
      const next = await this.write(record, 'reserved', { run_id: allocateRunId(record) });
      return { reserved: true, record: next };
    });
  }

  /** `reserved → spawning`, just before the worker is started. */
  public markSpawning(invocationId: string): Promise<InvocationRecord> {
    return this.transition(invocationId, 'spawning');
  }

  /**
   * The worker's first action: `reserved | spawning → claimed`, recording its
   * identity. A withdrawn invocation throws {@link ClaimRefusedError}.
   */
  public async claim(invocationId: string, worker: ProcessIdentity): Promise<InvocationRecord> {
    return this.withLock(async () => {
      const record = await this.require(invocationId);
      if (record.state === 'never_started' || record.state === 'discarded') {
        throw new ClaimRefusedError(invocationId, record.state);
      }
      if (record.state !== 'reserved' && record.state !== 'spawning') {
        throw new InvalidInvocationTransition(invocationId, record.state, 'claimed');
      }
      return this.write(record, 'claimed', {
        worker: { pid: worker.pid, start_token: worker.startToken },
      });
    });
  }

  /** `claimed → running`, once the run's lease exists. */
  public markRunning(invocationId: string): Promise<InvocationRecord> {
    return this.transition(invocationId, 'running');
  }

  /** `claimed | running → finished`, with the exit code and an optional reason. */
  public finish(
    invocationId: string,
    result: { readonly exitCode: number; readonly reason?: InvocationFinishReason },
  ): Promise<InvocationRecord> {
    return this.transition(invocationId, 'finished', {
      result: {
        exit_code: result.exitCode,
        finished_at: this.now().toISOString(),
        ...(result.reason === undefined ? {} : { reason: result.reason }),
      },
    });
  }

  /** Withdraws the invocation (`discarded` is terminal). */
  public discard(invocationId: string): Promise<InvocationRecord> {
    return this.transition(invocationId, 'discarded');
  }

  /** `reserved | spawning → never_started` (recovery, or a failed spawn). */
  public markNeverStarted(invocationId: string): Promise<InvocationRecord> {
    return this.transition(invocationId, 'never_started');
  }

  /** `spawning → start_unknown`: the worker may or may not have started. */
  public markStartUnknown(invocationId: string): Promise<InvocationRecord> {
    return this.transition(invocationId, 'start_unknown');
  }

  /**
   * Puts an item back in the queue (`needs_review | never_started |
   * start_unknown → queued`). `start_unknown` requires
   * `acknowledgeDuplicateRisk`, which is recorded.
   */
  public async requeue(
    invocationId: string,
    options: {
      readonly acknowledgeDuplicateRisk?: boolean;
      readonly argv?: readonly string[];
    } = {},
  ): Promise<InvocationRecord> {
    return this.withLock(async () => {
      const record = await this.require(invocationId);
      if (record.state === 'start_unknown' && options.acknowledgeDuplicateRisk !== true) {
        throw new InvalidInvocationTransition(invocationId, record.state, 'queued');
      }
      return this.write(record, 'queued', {
        review: null,
        run_id: null,
        worker: null,
        ...(record.state === 'start_unknown' ? { duplicate_risk_acknowledged: true } : {}),
        ...(options.argv === undefined
          ? {}
          : { invocation: { ...record.invocation, argv: [...options.argv] } }),
      });
    });
  }

  /** `queued → needs_review` with the differences drift review found. */
  public setReview(
    invocationId: string,
    differences: readonly DriftDifference[],
  ): Promise<InvocationRecord> {
    return this.transition(invocationId, 'needs_review', {
      review: { detected_at: this.now().toISOString(), differences: [...differences] },
    });
  }

  /** Writes the worker's result once (exclusive), capping the envelope at 1 MiB. */
  public async writeResult(invocationId: string, outcome: CommandResultMessage): Promise<boolean> {
    const record = await this.get(invocationId);
    const result = InvocationResult.parse({
      schema_version: 1,
      invocation_id: invocationId,
      ...(typeof record?.run_id === 'string' ? { run_id: record.run_id } : {}),
      outcome: capResultEnvelope(outcome),
    });
    try {
      await writeFileAtomic(this.resultPathOf(invocationId), `${JSON.stringify(result)}\n`, {
        exclusive: true,
        fsync: true,
        mode: 0o600,
      });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
  }

  /** The worker's result, or null when none was written (or it is unreadable). */
  public async readResult(invocationId: string): Promise<InvocationResult | null> {
    try {
      const parsed = InvocationResult.safeParse(
        JSON.parse(await readFile(this.resultPathOf(invocationId), 'utf8')) as unknown,
      );
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  /**
   * Runs `body` holding `slots.lock`: waits up to `lockWaitMs`, then throws
   * {@link SlotLockBusyError}. Nothing is written without the lock.
   */
  public async withLock<T>(body: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + this.lockWaitMs;
    await mkdir(dirname(this.lockPath), { recursive: true, mode: 0o700 });
    let release: () => Promise<void>;
    for (;;) {
      try {
        release = await this.lock(this.lockPath, {
          realpath: false,
          retries: 0,
          stale: LOCK_STALE_MS,
          lockfilePath: `${this.lockPath}.lck`,
        });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ELOCKED' || Date.now() >= deadline) {
          if ((error as NodeJS.ErrnoException).code === 'ELOCKED') throw new SlotLockBusyError();
          throw error;
        }
        await delay(LOCK_POLL_MS);
      }
    }
    try {
      return await body();
    } finally {
      await release().catch(() => undefined);
    }
  }

  /**
   * Moves `record` to `to` without taking the lock. Only for a caller that
   * already holds it inside {@link withLock} (recovery).
   */
  public applyUnlocked(record: InvocationRecord, to: InvocationState): Promise<InvocationRecord> {
    return this.write(record, to, {});
  }

  private async transition(
    invocationId: string,
    to: InvocationState,
    patch: Partial<InvocationRecord> = {},
  ): Promise<InvocationRecord> {
    return this.withLock(async () => this.write(await this.require(invocationId), to, patch));
  }

  /** Writes `record` moved to `to` (checked against the table). Call under the lock. */
  private async write(
    record: InvocationRecord,
    to: InvocationState,
    patch: Partial<InvocationRecord>,
  ): Promise<InvocationRecord> {
    if (!canTransition(record.state, to)) {
      throw new InvalidInvocationTransition(record.invocation_id, record.state, to);
    }
    const next = InvocationRecord.parse({
      ...record,
      ...patch,
      state: to,
      updated_at: this.now().toISOString(),
    });
    await publishWithRetry(this.pathOf(next.invocation_id), this.serialize(next));
    return next;
  }

  private async require(invocationId: string): Promise<InvocationRecord> {
    const record = await this.get(invocationId);
    if (record === null) throw new Error(`No invocation ${invocationId}.`);
    return record;
  }

  /** `<root>/<id>.json`; the ID check (via `invocationPath`) keeps it inside `root`. */
  private pathOf(invocationId: string): string {
    return join(this.root, basename(invocationPath(invocationId)));
  }

  /** `<root>/<id>.result.json`, checked the same way. */
  private resultPathOf(invocationId: string): string {
    return join(this.root, basename(invocationResultPath(invocationId)));
  }

  private serialize(record: InvocationRecord): string {
    return `${JSON.stringify(record)}\n`;
  }
}
