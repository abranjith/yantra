/**
 * Coordination for the single managed installation.
 *
 * Two claims exist and they are mutually exclusive at claim time: any number of
 * *use reservations* (a run is holding the installation open) and at most one
 * *mutation lease* (an explicit install or update is writing a candidate).
 *
 * There is deliberately no transaction phase machine and no recovery routine.
 * The disjoint-child layout plus one atomically published pointer makes every
 * interrupted state the same state, so this module never repairs anything: a
 * dead mutation owner simply blocks nothing, and its candidate is an orphan
 * that the next explicit install/update collects.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import lockfile from 'proper-lockfile';
import { z } from 'zod';

import { ManagedCoordinationError } from './errors.js';
import type {
  ManagedCoordinator,
  ManagedMutationLease,
  ManagedReadyRecord,
  ManagedStateReader,
  ManagedUsePhase,
  ManagedUseReservation,
  ProcessIdentity,
  ProcessLivenessProbe,
} from './installation-types.js';
import { LocalManagedStateReader } from './managed-state.js';
import { managedCoordinationPath, managedOperationPath } from './paths.js';
import { NodeProcessLivenessProbe, currentProcessIdentity } from './process-identity.js';

const CHILD_CACHE_PATTERN = /^installation-[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** How long a held mutex is considered fresh. Every hold here is milliseconds. */
const MUTEX_STALE_MS = 10_000;
const MUTEX_RETRIES = { retries: 12, factor: 1.4, minTimeout: 20, maxTimeout: 500 };

const ProcessIdentitySchema = z.object({
  pid: z.number().int().positive(),
  startToken: z.string().min(1),
});

const ReservationRecordSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  installationId: z.string().min(1),
  parent: ProcessIdentitySchema,
  child: ProcessIdentitySchema.nullable(),
  phase: z.enum(['starting', 'running', 'stopping']),
  createdAt: z.string(),
});

type ReservationRecord = z.infer<typeof ReservationRecordSchema>;

const OperationRecordSchema = z.object({
  schemaVersion: z.literal(1),
  operationId: z.string().min(1),
  candidateRootRelative: z.string().refine((v) => CHILD_CACHE_PATTERN.test(v), {
    message: 'candidateRootRelative must be exactly one "installation-<id>" segment',
  }),
  owner: ProcessIdentitySchema,
  claimedAt: z.string(),
});

type OperationRecord = z.infer<typeof OperationRecordSchema>;

/**
 * A reservation as its owner holds it.
 *
 * {@link ManagedUseReservation} is the contract every consumer sees;
 * `markNeverSpawned` is the extra proof only the launcher can supply, and it is
 * the *only* way a reservation with no attached child is ever released.
 */
export interface OwnedManagedUseReservation extends ManagedUseReservation {
  /** Proof that no browser process was ever created for this reservation. */
  markNeverSpawned(): Promise<void>;
  /** Last phase this process wrote. */
  readonly phase: ManagedUsePhase;
}

// ---------------------------------------------------------------------------
// Candidate probe permits
// ---------------------------------------------------------------------------

interface PermitEntry {
  readonly operationId: string;
  readonly candidateRootRelative: string;
  readonly executablePath: string;
  readonly lease: FileManagedMutationLease;
  revoked: boolean;
  readonly pendingExits: Set<Promise<unknown>>;
}

/**
 * Authorization to launch one synthetic probe against a candidate installation.
 *
 * The nominal brand is a private field, so a permit cannot be constructed
 * outside this module even structurally; the registry below is the runtime half,
 * so a forged or replayed permit is still refused when the type system is
 * bypassed with a cast.
 */
export class CandidateProbePermit {
  readonly #brand = 'yantra.candidate-probe-permit';

  readonly operationId: string;
  readonly candidateRootRelative: string;
  readonly executablePath: string;

  private constructor(operationId: string, candidateRootRelative: string, executablePath: string) {
    this.operationId = operationId;
    this.candidateRootRelative = candidateRootRelative;
    this.executablePath = executablePath;
    void this.#brand;
  }

  /** @internal Only {@link issueCandidateProbePermit} may mint a permit. */
  static mint(
    operationId: string,
    candidateRootRelative: string,
    executablePath: string,
  ): CandidateProbePermit {
    return new CandidateProbePermit(operationId, candidateRootRelative, executablePath);
  }
}

const permitRegistry = new WeakMap<CandidateProbePermit, PermitEntry>();

/**
 * Issues a probe permit bound to one live lease, candidate root, and executable.
 *
 * @internal Not re-exported through the public core barrel — a permit exists so
 * the probe can bypass *this operation's own* exclusion, never so ordinary code
 * can launch a browser outside the normal path.
 */
export function issueCandidateProbePermit(
  lease: ManagedMutationLease,
  candidate: { readonly candidateRootRelative: string; readonly executablePath: string },
): CandidateProbePermit {
  if (!(lease instanceof FileManagedMutationLease)) {
    throw new ManagedCoordinationError({
      reason: 'invalid-permit',
      detail: 'A candidate probe permit can only be issued against a live mutation lease.',
      remediation: 'Claim the mutation lease before probing a candidate.',
    });
  }
  if (candidate.candidateRootRelative !== lease.candidateRootRelative) {
    throw new ManagedCoordinationError({
      reason: 'invalid-permit',
      detail: `The lease authorizes "${lease.candidateRootRelative}", not "${candidate.candidateRootRelative}".`,
      remediation: 'Probe only the candidate this operation is writing.',
    });
  }
  const permit = CandidateProbePermit.mint(
    lease.operationId,
    candidate.candidateRootRelative,
    candidate.executablePath,
  );
  const entry: PermitEntry = {
    operationId: lease.operationId,
    candidateRootRelative: candidate.candidateRootRelative,
    executablePath: candidate.executablePath,
    lease,
    revoked: false,
    pendingExits: new Set(),
  };
  permitRegistry.set(permit, entry);
  lease.registerPermit(entry);
  return permit;
}

/**
 * Validates a permit at the moment of use.
 *
 * Ownership is re-proved here rather than trusted from issue time: a lease can
 * be lost between minting and spawning, and a probe that outlives its operation
 * would be writing into a tree another operation may already own.
 *
 * @internal
 */
export async function assertCandidateProbePermit(
  permit: CandidateProbePermit,
  expected: { readonly candidateRootRelative: string; readonly executablePath: string },
): Promise<void> {
  const entry = permitRegistry.get(permit);
  if (entry === undefined || entry.revoked) {
    throw new ManagedCoordinationError({
      reason: 'invalid-permit',
      detail: 'The candidate probe permit is forged, revoked, or already completed.',
      remediation: 'Re-issue a permit from the operation that owns the candidate.',
    });
  }
  if (
    entry.candidateRootRelative !== expected.candidateRootRelative ||
    entry.executablePath !== expected.executablePath
  ) {
    throw new ManagedCoordinationError({
      reason: 'invalid-permit',
      detail: 'The candidate probe permit does not authorize this candidate or executable.',
      remediation: 'Probe only the exact candidate the permit names.',
    });
  }
  await entry.lease.assertOwned();
}

/** Registers a probe process whose exit the lease must await. @internal */
export function trackCandidateProbeProcess(
  permit: CandidateProbePermit,
  exited: Promise<unknown>,
): void {
  const entry = permitRegistry.get(permit);
  if (entry === undefined) return;
  const settled = exited.catch(() => undefined);
  entry.pendingExits.add(settled);
  void settled.finally(() => entry.pendingExits.delete(settled));
}

/** Revokes a permit on cancellation or completion. @internal */
export function revokeCandidateProbePermit(permit: CandidateProbePermit): void {
  const entry = permitRegistry.get(permit);
  if (entry !== undefined) entry.revoked = true;
}

// ---------------------------------------------------------------------------
// Coordinator
// ---------------------------------------------------------------------------

export interface ManagedCoordinatorDeps {
  readonly managedState?: ManagedStateReader;
  readonly liveness?: ProcessLivenessProbe;
  readonly coordinationRoot?: () => string;
  readonly operationPath?: () => string;
  readonly selfIdentity?: () => Promise<ProcessIdentity>;
  readonly clock?: () => Date;
  readonly newId?: () => string;
}

/** Filesystem-backed {@link ManagedCoordinator}. */
export class LocalManagedCoordinator implements ManagedCoordinator {
  private readonly managedState: ManagedStateReader;
  private readonly liveness: ProcessLivenessProbe;
  private readonly coordinationRoot: () => string;
  private readonly operationPath: () => string;
  private readonly selfIdentity: () => Promise<ProcessIdentity>;
  private readonly clock: () => Date;
  private readonly newId: () => string;

  constructor(deps: ManagedCoordinatorDeps = {}) {
    this.managedState = deps.managedState ?? new LocalManagedStateReader();
    this.liveness = deps.liveness ?? new NodeProcessLivenessProbe();
    this.coordinationRoot = deps.coordinationRoot ?? managedCoordinationPath;
    this.operationPath = deps.operationPath ?? managedOperationPath;
    this.selfIdentity = deps.selfIdentity ?? currentProcessIdentity;
    this.clock = deps.clock ?? (() => new Date());
    this.newId = deps.newId ?? randomUUID;
  }

  /**
   * @inheritdoc
   *
   * Readiness is re-validated *under the mutex* against the installation the
   * caller resolved: between resolution and reservation an update may have
   * published a different build, and reserving the old one would hold a claim
   * on a tree that is already an orphan.
   */
  async reserveUse(expected: ManagedReadyRecord): Promise<OwnedManagedUseReservation> {
    return this.withMutex(async () => {
      const ready = await this.managedState.readReady();
      if (ready.status !== 'ready' || !sameInstallation(ready.record, expected)) {
        throw new ManagedCoordinationError({
          reason: 'ready-changed',
          detail:
            ready.status === 'ready'
              ? `The managed installation changed to build ${ready.record.buildId} before the reservation was taken.`
              : `The managed installation is no longer ready (${ready.status}).`,
          remediation: 'Re-resolve the browser and try again.',
        });
      }

      const operation = await this.readOperation();
      if (operation !== null) {
        const verdict = await this.liveness.check(operation.owner);
        if (verdict !== 'dead') {
          throw new ManagedCoordinationError({
            reason: 'operation-in-progress',
            detail: `A managed browser ${operation.operationId} operation is in progress (pid ${operation.owner.pid}, liveness ${verdict}).`,
            remediation: 'Wait for it to finish, then retry.',
          });
        }
        // A dead owner blocks nothing. Its candidate is simply an orphan, and
        // collecting it belongs to the next explicit install/update.
      }

      const parent = await this.selfIdentity();
      const record: ReservationRecord = {
        schemaVersion: 1,
        id: this.newId(),
        installationId: expected.installationId,
        parent,
        child: null,
        phase: 'starting',
        createdAt: this.clock().toISOString(),
      };
      await this.writeReservation(record);
      return new FileManagedUseReservation(this, record);
    });
  }

  /** @inheritdoc */
  async claimMutation(
    operationId: string,
    candidateRootRelative: string,
  ): Promise<ManagedMutationLease> {
    if (!CHILD_CACHE_PATTERN.test(candidateRootRelative)) {
      throw new ManagedCoordinationError({
        reason: 'invalid-permit',
        detail: `"${candidateRootRelative}" is not a legal candidate cache root.`,
        remediation: 'Use exactly one "installation-<id>" segment.',
      });
    }
    return this.withMutex(async () => {
      const active = await this.findActiveReservation();
      if (active !== null) {
        throw new ManagedCoordinationError({
          reason: 'active-use',
          detail: `A managed browser run is active (reservation ${active.record.id}, phase ${active.record.phase}, ${active.why}).`,
          remediation: 'Stop the running Yantra browser sessions, then retry.',
        });
      }
      const existing = await this.readOperation();
      if (existing !== null) {
        const verdict = await this.liveness.check(existing.owner);
        if (verdict !== 'dead') {
          throw new ManagedCoordinationError({
            reason: 'operation-in-progress',
            detail: `Another managed browser operation ${existing.operationId} is in progress (pid ${existing.owner.pid}, liveness ${verdict}).`,
            remediation: 'Wait for it to finish, then retry.',
          });
        }
      }
      const owner = await this.selfIdentity();
      const record: OperationRecord = {
        schemaVersion: 1,
        operationId,
        candidateRootRelative,
        owner,
        claimedAt: this.clock().toISOString(),
      };
      await mkdir(join(this.operationPath(), '..'), { recursive: true, mode: 0o700 });
      await writeFile(this.operationPath(), JSON.stringify(record), { mode: 0o600 });
      return new FileManagedMutationLease(this, record);
    });
  }

  /** @inheritdoc */
  async hasActiveUse(): Promise<boolean> {
    return (await this.findActiveReservation()) !== null;
  }

  /**
   * PIDs currently holding the installation open, for a refusal that can name them.
   *
   * A read-only projection of {@link findActiveReservation} — deliberately not a
   * second liveness rule. "Stop the browser that is blocking me" is unactionable
   * advice if the message cannot say which browser.
   */
  async activeUseOwners(): Promise<readonly number[]> {
    const pids = new Set<number>();
    for (const record of await this.readReservations()) {
      if (record.child !== null) {
        if ((await this.liveness.check(record.child)) !== 'dead') {
          pids.add(record.child.pid);
          continue;
        }
        continue;
      }
      const parentVerdict = await this.liveness.check(record.parent);
      if (parentVerdict !== 'dead' || record.phase === 'starting') pids.add(record.parent.pid);
    }
    return [...pids];
  }

  /**
   * Candidate root a *live* mutation currently owns, for the orphan inventory.
   *
   * A dead owner's candidate is reported as an ordinary owner-less orphan,
   * which is exactly what it is.
   */
  liveMutationCandidate = async (): Promise<string | null> => {
    const operation = await this.readOperation();
    if (operation === null) return null;
    const verdict = await this.liveness.check(operation.owner);
    return verdict === 'dead' ? null : operation.candidateRootRelative;
  };

  // -------------------------------------------------------------------------
  // Internals shared with the reservation/lease handles
  // -------------------------------------------------------------------------

  /** @internal */
  async withMutex<T>(fn: () => Promise<T>): Promise<T> {
    const root = this.coordinationRoot();
    await mkdir(root, { recursive: true, mode: 0o700 });
    const target = join(root, 'mutex');
    await writeFile(target, '', { flag: 'a' });
    const release = await lockfile.lock(target, {
      stale: MUTEX_STALE_MS,
      realpath: false,
      retries: MUTEX_RETRIES,
    });
    try {
      return await fn();
    } finally {
      await release().catch(() => undefined);
    }
  }

  /** @internal */
  reservationPath(id: string): string {
    return join(this.coordinationRoot(), 'reservations', `${id}.json`);
  }

  /** @internal */
  async writeReservation(record: ReservationRecord): Promise<void> {
    const path = this.reservationPath(record.id);
    await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
    await writeFile(path, JSON.stringify(record), { mode: 0o600 });
  }

  /** @internal */
  async removeReservation(id: string): Promise<void> {
    await rm(this.reservationPath(id), { force: true });
  }

  /** @internal */
  async readOperation(): Promise<OperationRecord | null> {
    let raw: string;
    try {
      raw = await readFile(this.operationPath(), 'utf8');
    } catch {
      return null;
    }
    try {
      const parsed = OperationRecordSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  /** @internal */
  async clearOperation(operationId: string): Promise<void> {
    const existing = await this.readOperation();
    if (existing?.operationId !== operationId) return;
    await rm(this.operationPath(), { force: true });
  }

  /** @internal */
  get livenessProbe(): ProcessLivenessProbe {
    return this.liveness;
  }

  /** @internal */
  async readReservations(): Promise<readonly ReservationRecord[]> {
    const dir = join(this.coordinationRoot(), 'reservations');
    let names: readonly string[];
    try {
      names = await readdir(dir);
    } catch {
      return [];
    }
    const records: ReservationRecord[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        const parsed = ReservationRecordSchema.safeParse(
          JSON.parse(await readFile(join(dir, name), 'utf8')),
        );
        if (parsed.success) records.push(parsed.data);
      } catch {
        // A half-written or corrupt reservation is not evidence of a live run.
      }
    }
    return records;
  }

  /**
   * First reservation that still counts as busy, with why it does.
   *
   * The rules are deliberately conservative in both directions a browser can
   * outlive its owner: a dead parent with a live or uncertain child is busy,
   * and a `starting` reservation whose child state cannot be proved is busy
   * too, because the owner may have spawned a browser it never got to record.
   *
   * @internal
   */
  async findActiveReservation(): Promise<{
    readonly record: ReservationRecord;
    readonly why: string;
  } | null> {
    for (const record of await this.readReservations()) {
      if (record.child !== null) {
        const childVerdict = await this.liveness.check(record.child);
        if (childVerdict !== 'dead')
          return { record, why: `browser pid ${record.child.pid} is ${childVerdict}` };
        continue;
      }
      const parentVerdict = await this.liveness.check(record.parent);
      if (parentVerdict !== 'dead')
        return { record, why: `owner pid ${record.parent.pid} is ${parentVerdict}` };
      if (record.phase === 'starting')
        return {
          record,
          why: `owner pid ${record.parent.pid} died while starting and the browser state cannot be proved`,
        };
    }
    return null;
  }
}

function sameInstallation(a: ManagedReadyRecord, b: ManagedReadyRecord): boolean {
  return (
    a.installationId === b.installationId &&
    a.buildId === b.buildId &&
    a.cacheRootRelative === b.cacheRootRelative &&
    a.executableRelative === b.executableRelative
  );
}

// ---------------------------------------------------------------------------
// Handles
// ---------------------------------------------------------------------------

class FileManagedUseReservation implements OwnedManagedUseReservation {
  readonly id: string;
  readonly installationId: string;

  private readonly coordinator: LocalManagedCoordinator;
  private record: ReservationRecord;
  private released = false;

  constructor(coordinator: LocalManagedCoordinator, record: ReservationRecord) {
    this.coordinator = coordinator;
    this.record = record;
    this.id = record.id;
    this.installationId = record.installationId;
  }

  get phase(): ManagedUsePhase {
    return this.record.phase;
  }

  /**
   * @inheritdoc
   *
   * Called the moment a process handle exists, not when startup succeeds: the
   * window between spawn and success is exactly where an unrecorded browser
   * would be left behind.
   */
  async attachChild(child: ProcessIdentity): Promise<void> {
    if (this.released) return;
    await this.coordinator.withMutex(async () => {
      this.record = { ...this.record, child, phase: 'running' };
      await this.coordinator.writeReservation(this.record);
    });
  }

  /** Proof that no browser was created. The only release path with no child. */
  async markNeverSpawned(): Promise<void> {
    if (this.released) return;
    await this.coordinator.withMutex(async () => {
      this.record = { ...this.record, child: null, phase: 'stopping' };
      await this.coordinator.writeReservation(this.record);
    });
    await this.releaseAfterExit();
  }

  /**
   * @inheritdoc
   *
   * A signal sent and a Puppeteer disconnect are both *requests*; neither is
   * proof that the process tree is gone. The reservation is kept — and a typed
   * error raised — until liveness says the child is definitively dead.
   */
  async releaseAfterExit(): Promise<void> {
    if (this.released) return;
    await this.coordinator.withMutex(async () => {
      if (this.released) return;
      if (this.record.child !== null) {
        const verdict = await this.coordinator.livenessProbe.check(this.record.child);
        if (verdict !== 'dead') {
          throw new ManagedCoordinationError({
            reason: 'uncertain-owner',
            detail: `The managed browser process (pid ${this.record.child.pid}) is ${verdict}; the reservation is kept.`,
            remediation: 'Close the browser, then retry.',
          });
        }
      } else if (this.record.phase !== 'stopping') {
        throw new ManagedCoordinationError({
          reason: 'uncertain-owner',
          detail:
            'The reservation has no recorded browser process and startup was never resolved; the reservation is kept.',
          remediation: 'Retry after the pending startup settles.',
        });
      }
      this.released = true;
      await this.coordinator.removeReservation(this.record.id);
    });
  }
}

class FileManagedMutationLease implements ManagedMutationLease {
  readonly operationId: string;
  readonly candidateRootRelative: string;

  private readonly coordinator: LocalManagedCoordinator;
  private readonly owner: ProcessIdentity;
  private readonly permits = new Set<PermitEntry>();
  private released = false;

  constructor(coordinator: LocalManagedCoordinator, record: OperationRecord) {
    this.coordinator = coordinator;
    this.operationId = record.operationId;
    this.candidateRootRelative = record.candidateRootRelative;
    this.owner = record.owner;
  }

  /** @internal */
  registerPermit(entry: PermitEntry): void {
    this.permits.add(entry);
  }

  /** @inheritdoc */
  async assertOwned(): Promise<void> {
    if (this.released) {
      throw new ManagedCoordinationError({
        reason: 'lost-ownership',
        detail: `Operation ${this.operationId} has already released its mutation lease.`,
        remediation: 'Claim a new lease before continuing.',
      });
    }
    const current = await this.coordinator.readOperation();
    if (
      current?.operationId !== this.operationId ||
      current.owner.pid !== this.owner.pid ||
      current.owner.startToken !== this.owner.startToken
    ) {
      throw new ManagedCoordinationError({
        reason: 'lost-ownership',
        detail: `Operation ${this.operationId} no longer owns the managed mutation claim.`,
        remediation: 'Stop this operation and retry from a fresh claim.',
      });
    }
  }

  /**
   * @inheritdoc
   *
   * Release waits for every candidate probe process this lease authorized: a
   * released lease means the candidate tree is free for the next operation, and
   * a probe still holding files open would make that a lie.
   */
  async release(): Promise<void> {
    if (this.released) return;
    for (const entry of this.permits) {
      entry.revoked = true;
      await Promise.all([...entry.pendingExits]);
    }
    this.released = true;
    await this.coordinator.clearOperation(this.operationId);
  }
}
