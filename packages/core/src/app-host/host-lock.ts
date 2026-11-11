/**
 * The app host's single-instance lock (FEAT-065 TASK-001, plan D2).
 *
 * `host.lock` is a JSON {@link HostLockRecord}, never a bare PID. Whether its
 * holder still runs is decided only by creation identity through an injected
 * {@link ProcessLivenessProbe}: a dead or reused-PID holder is replaced, an
 * `unknown` one is never reclaimed (memory → Architecture).
 *
 * Every read-modify-write runs inside a short `proper-lockfile` mutex on a
 * sibling `host.lock.mutex`, so two `yantra ui` invocations racing to start a
 * host end with exactly one acquirer. Records are published atomically
 * (unique temp file, then rename), so a reader never sees a partial record.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

import { HostLockRecord } from '@yantra/protocol';
import lockfile from 'proper-lockfile';

import type {
  LivenessVerdict,
  ProcessIdentity,
  ProcessLivenessProbe,
} from '../browser/installation-types.js';
import { uiHostLockPath } from '../browser/paths.js';
import { NodeProcessLivenessProbe } from '../browser/process-identity.js';
import { writeFileAtomic } from '../fs/atomic-write.js';

import { HostLockHeldError } from './errors.js';

/** What a host declares about itself when it takes the lock. */
export interface HostLockMetadata {
  readonly build_id: string;
  readonly yantra_version: string;
  readonly channel_version: number;
  /** When the host captured the environment its workers inherit (D13); defaults to now. */
  readonly env_captured_at?: string;
}

/** What a ready host publishes once both listeners are bound. */
export interface HostLockReady {
  readonly port: number;
  readonly control_socket: string;
  readonly build_id?: string;
}

/** The record (if any) and what the liveness probe says about its holder. */
export type HostLockProbe =
  | { readonly verdict: 'absent'; readonly record: null }
  | { readonly verdict: 'corrupt'; readonly record: null }
  | { readonly verdict: LivenessVerdict; readonly record: HostLockRecord };

export interface FileHostLockOptions {
  /** Lock file; defaults to `uiHostLockPath()`. */
  readonly path?: string;
  readonly liveness?: ProcessLivenessProbe;
  /** Random-bytes seam for the control token. */
  readonly random?: (size: number) => Buffer;
  readonly now?: () => Date;
  /** `proper-lockfile` seam. */
  readonly lock?: typeof lockfile.lock;
}

/** How long the mutex may be waited for; the critical section is a few file operations. */
const MUTEX_RETRIES = { retries: 80, factor: 1, minTimeout: 25, maxTimeout: 25 };
const MUTEX_STALE_MS = 10_000;

/** The app host's `host.lock`; see the module comment. */
export class FileHostLock {
  public readonly path: string;
  private readonly liveness: ProcessLivenessProbe;
  private readonly random: (size: number) => Buffer;
  private readonly now: () => Date;
  private readonly lock: typeof lockfile.lock;
  private owner: ProcessIdentity | null = null;

  public constructor(options: FileHostLockOptions = {}) {
    this.path = options.path ?? uiHostLockPath();
    this.liveness = options.liveness ?? new NodeProcessLivenessProbe();
    this.random = options.random ?? randomBytes;
    this.now = options.now ?? (() => new Date());
    this.lock = options.lock ?? lockfile.lock;
  }

  /**
   * Takes the lock for `identity`, writing a `starting` record with a fresh
   * 256-bit control token.
   *
   * @throws HostLockHeldError when a live (`uncertain: false`) or unverifiable
   *   (`uncertain: true`) holder exists, or the record cannot be read.
   */
  public async acquire(
    identity: ProcessIdentity,
    metadata: HostLockMetadata,
  ): Promise<HostLockRecord> {
    return this.withMutex(async () => {
      const current = await this.inspect();
      if (current.verdict === 'corrupt') throw new HostLockHeldError(null, true, this.path);
      if (current.verdict === 'alive')
        throw new HostLockHeldError(current.record, false, this.path);
      if (current.verdict === 'unknown')
        throw new HostLockHeldError(current.record, true, this.path);
      // absent, or dead (including a reused PID): the record is replaced.
      const startedAt = this.now().toISOString();
      const record = HostLockRecord.parse({
        schema_version: 1,
        state: 'starting',
        pid: identity.pid,
        start_token: identity.startToken,
        port: null,
        control_socket: null,
        control_token: this.random(32).toString('base64url'),
        build_id: metadata.build_id,
        yantra_version: metadata.yantra_version,
        channel_version: metadata.channel_version,
        started_at: startedAt,
        env_captured_at: metadata.env_captured_at ?? startedAt,
      });
      await this.publish(record);
      this.owner = identity;
      return record;
    });
  }

  /** Rewrites this host's record as `ready`. Throws if this process no longer owns it. */
  public async markReady(ready: HostLockReady): Promise<HostLockRecord> {
    return this.withMutex(async () => {
      const current = await this.ownedRecord();
      const record = HostLockRecord.parse({
        ...current,
        state: 'ready',
        port: ready.port,
        control_socket: ready.control_socket,
        build_id: ready.build_id ?? current.build_id,
      });
      await this.publish(record);
      return record;
    });
  }

  /** Reads the record and checks its holder; never modifies anything. */
  public async probe(): Promise<HostLockProbe> {
    return this.inspect();
  }

  /**
   * Removes the record only when it still carries this process's identity.
   * Returns whether it was removed.
   */
  public async release(): Promise<boolean> {
    if (this.owner === null) return false;
    return this.withMutex(async () => {
      const current = await this.inspect();
      const mine = current.record !== null && this.isOwner(current.record);
      if (mine) await rm(this.path, { force: true });
      this.owner = null;
      return mine;
    });
  }

  private isOwner(record: HostLockRecord): boolean {
    return (
      this.owner !== null &&
      record.pid === this.owner.pid &&
      record.start_token === this.owner.startToken
    );
  }

  private async ownedRecord(): Promise<HostLockRecord> {
    const current = await this.inspect();
    if (current.record === null || !this.isOwner(current.record)) {
      throw new Error('This process no longer owns the app host lock.');
    }
    return current.record;
  }

  private async inspect(): Promise<HostLockProbe> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { verdict: 'absent', record: null };
      return { verdict: 'corrupt', record: null };
    }
    let parsed: ReturnType<typeof HostLockRecord.safeParse>;
    try {
      parsed = HostLockRecord.safeParse(JSON.parse(raw) as unknown);
    } catch {
      return { verdict: 'corrupt', record: null };
    }
    if (!parsed.success) return { verdict: 'corrupt', record: null };
    const record = parsed.data;
    const verdict = await this.liveness.check({ pid: record.pid, startToken: record.start_token });
    return { verdict, record };
  }

  private async publish(record: HostLockRecord): Promise<void> {
    await writeFileAtomic(this.path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  }

  private async withMutex<T>(body: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const release = await this.lock(this.path, {
      realpath: false,
      lockfilePath: `${this.path}.mutex`,
      stale: MUTEX_STALE_MS,
      retries: MUTEX_RETRIES,
    });
    try {
      return await body();
    } finally {
      await release().catch(() => undefined);
    }
  }
}
