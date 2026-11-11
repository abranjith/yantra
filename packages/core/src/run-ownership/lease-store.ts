/**
 * The run lease (FEAT-064): exclusive ownership of a run directory.
 *
 * `lease.json` is published once, by `link`ing a complete unique temp file, so
 * a reader never sees a partial lease and a second claimant gets `EEXIST`. It
 * is **never rewritten** while the owner runs: on Windows a rename over a file
 * any reader holds open fails (spike S2, RC2). Mutable ownership state lives
 * in the append-only `owned-browsers.jsonl` instead.
 *
 * Write-ordering invariants every caller keeps:
 * 1. the lease is claimed before the manifest says `running`;
 * 2. the terminal event and terminal manifest are flushed before the lease is
 *    released. A `running` manifest with no lease can only mean a dead owner.
 */

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import {
  CHANNEL_VERSION,
  OwnedBrowserEvent,
  RUN_LEASE_SCHEMA_VERSION,
  RunLease,
  type ExecutionClass,
  type RunLeaseOrigin,
  type RunSocketAddress,
} from '@yantra/protocol';

import type {
  LivenessVerdict,
  ProcessIdentity,
  ProcessLivenessProbe,
} from '../browser/installation-types.js';
import { NodeProcessLivenessProbe, currentProcessIdentity } from '../browser/process-identity.js';
import { writeFileAtomic } from '../fs/atomic-write.js';

import { OWNED_BROWSERS_FILENAME, RUN_LEASE_FILENAME } from './constants.js';
import { RunLeaseHeldError, RunOwnershipError } from './errors.js';

/** A fresh run token: 32 random bytes, base64url without padding (43 characters). */
export function generateRunToken(): string {
  return randomBytes(32).toString('base64url');
}

let cachedVersion: string | null = null;

/** The version of the Yantra executable, from core's package.json. */
export function yantraVersion(): string {
  if (cachedVersion !== null) return cachedVersion;
  try {
    const raw = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
    const version = (JSON.parse(raw) as { version?: unknown }).version;
    cachedVersion = typeof version === 'string' && version.length > 0 ? version : '0.0.0';
  } catch {
    cachedVersion = '0.0.0';
  }
  return cachedVersion;
}

/** Everything a claim needs besides the owner's identity. */
export interface LeaseClaimInit {
  readonly runId: string;
  readonly origin: RunLeaseOrigin;
  readonly executionClass: ExecutionClass;
  readonly command: readonly string[];
  readonly socket: RunSocketAddress;
  /** Generated when absent. A session passes the token its server already holds. */
  readonly runToken?: string;
  /** Last committed `run-events.jsonl` seq at claim: the start of this ownership epoch. */
  readonly logSeqAtClaim: number;
}

export interface LeaseClaimDeps {
  /** Defaults to this process's memoized creation identity. */
  readonly identity?: ProcessIdentity;
  /** Used only to name the holder's verdict when the claim loses. */
  readonly probe?: ProcessLivenessProbe;
  readonly clock?: () => Date;
}

function leasePath(runDir: string): string {
  return join(runDir, RUN_LEASE_FILENAME);
}

/** Builds a lease record; exported for takeover, which publishes it itself. */
export async function buildLease(
  init: LeaseClaimInit,
  deps: LeaseClaimDeps = {},
): Promise<RunLease> {
  const identity = deps.identity ?? (await currentProcessIdentity());
  const [first, ...rest] = init.command;
  if (first === undefined) {
    throw new RunOwnershipError('RUN_OWNERSHIP_CLAIM_FAILED', 'A run lease needs a command.');
  }
  return {
    schema_version: RUN_LEASE_SCHEMA_VERSION,
    run_id: init.runId,
    owner: { pid: identity.pid, start_token: identity.startToken },
    origin: init.origin,
    execution_class: init.executionClass,
    command: [first, ...rest],
    socket: init.socket,
    run_token: init.runToken ?? generateRunToken(),
    channel_version: CHANNEL_VERSION,
    yantra_version: yantraVersion(),
    log_seq_at_claim: init.logSeqAtClaim,
    claimed_at: (deps.clock ?? (() => new Date()))().toISOString(),
  };
}

/** Publishes a lease record by exclusive `link`; `EEXIST` propagates. */
export async function publishLease(runDir: string, lease: RunLease): Promise<void> {
  await writeFileAtomic(leasePath(runDir), `${JSON.stringify(lease)}\n`, {
    exclusive: true,
    fsync: true,
    mode: 0o600,
  });
}

/**
 * Claims the run directory for this process.
 *
 * @throws RunLeaseHeldError when a lease already exists; it names the
 *   holder and its liveness verdict. The temp file is always removed.
 */
export async function claimLease(
  runDir: string,
  init: LeaseClaimInit,
  deps: LeaseClaimDeps = {},
): Promise<RunLease> {
  const lease = await buildLease(init, deps);
  try {
    await publishLease(runDir, lease);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw new RunOwnershipError(
        'RUN_OWNERSHIP_CLAIM_FAILED',
        `Could not claim run ${init.runId}: ${(error as NodeJS.ErrnoException).code ?? 'error'}`,
        { cause: error },
      );
    }
    throw await heldError(runDir, init.runId, deps.probe);
  }
  return lease;
}

/** The busy error for an existing lease, with the holder's verdict. */
export async function heldError(
  runDir: string,
  runId: string,
  probe: ProcessLivenessProbe = new NodeProcessLivenessProbe(),
): Promise<RunLeaseHeldError> {
  const existing = await readLease(runDir);
  if (existing.kind === 'lease') {
    return new RunLeaseHeldError(runId, existing.lease, await ownerVerdict(existing.lease, probe));
  }
  return new RunLeaseHeldError(runId, null, existing.kind === 'corrupt' ? 'corrupt' : 'unknown');
}

/** What a lease read found. */
export type LeaseRead =
  | { readonly kind: 'lease'; readonly lease: RunLease }
  | { readonly kind: 'absent' }
  | { readonly kind: 'corrupt' };

const READ_RETRIES = 4;

/**
 * Reads `lease.json`. Never throws on a missing file; a lease that does not
 * parse is reported as corrupt. A Windows sharing violation (`EPERM`/`EBUSY`)
 * while another process unlinks it is retried briefly.
 */
export async function readLease(runDir: string): Promise<LeaseRead> {
  for (let attempt = 0; ; attempt += 1) {
    let raw: string;
    try {
      raw = await readFile(leasePath(runDir), 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'absent' };
      if ((code === 'EPERM' || code === 'EBUSY') && attempt < READ_RETRIES) {
        await delay(20 * (attempt + 1));
        continue;
      }
      throw new RunOwnershipError(
        'RUN_OWNERSHIP_LEASE_UNREADABLE',
        `Could not read ${RUN_LEASE_FILENAME}: ${code ?? 'error'}`,
        { cause: error },
      );
    }
    try {
      const parsed = RunLease.safeParse(JSON.parse(raw));
      return parsed.success ? { kind: 'lease', lease: parsed.data } : { kind: 'corrupt' };
    } catch {
      return { kind: 'corrupt' };
    }
  }
}

/** The owner's creation identity as recorded in a lease. */
export function leaseOwner(lease: RunLease): ProcessIdentity {
  return { pid: lease.owner.pid, startToken: lease.owner.start_token };
}

/** Whether the lease's owner is alive, decided only by creation identity. */
export function ownerVerdict(
  lease: RunLease,
  probe: ProcessLivenessProbe,
): Promise<LivenessVerdict> {
  return probe.check(leaseOwner(lease));
}

/**
 * Removes `lease.json`, the last act of an owner, and then only after the
 * terminal event and terminal manifest are flushed: the literal-typed
 * argument makes that ordering explicit at every call site.
 *
 * Browsers the run spawned whose exit was never proved stay recorded: the
 * lease and `owned-browsers.jsonl` are then kept as the "possible orphan"
 * record for a later reconcile to reap. Idempotent.
 *
 * @returns Whether the lease was removed.
 */
export async function releaseLease(
  runDir: string,
  _evidence: { readonly evidenceFlushed: true },
): Promise<{ readonly released: boolean; readonly retainedBrowsers: number }> {
  const outstanding = await readOwnedBrowsers(runDir);
  if (outstanding.length > 0) return { released: false, retainedBrowsers: outstanding.length };
  await removeOwnershipFiles(runDir);
  return { released: true, retainedBrowsers: 0 };
}

/** Removes the sidecar, then the lease (the lease is the record, so it goes last). */
export async function removeOwnershipFiles(runDir: string): Promise<void> {
  await removeWithRetry(join(runDir, OWNED_BROWSERS_FILENAME));
  await removeWithRetry(leasePath(runDir));
}

async function removeWithRetry(path: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rm(path, { force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code !== 'EPERM' && code !== 'EBUSY') || attempt >= READ_RETRIES) throw error;
      await delay(25 * (attempt + 1));
    }
  }
}

/**
 * Folds `owned-browsers.jsonl` into the identities spawned and not yet proved
 * exited, in first-spawn order. A trailing partial line and lines that do not
 * parse are ignored.
 */
export async function readOwnedBrowsers(runDir: string): Promise<ProcessIdentity[]> {
  let raw: string;
  try {
    raw = await readFile(join(runDir, OWNED_BROWSERS_FILENAME), 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw error;
  }
  const lines = raw.split('\n');
  lines.pop(); // empty after the final newline, or a partial line in flight
  const outstanding = new Map<string, ProcessIdentity>();
  for (const line of lines) {
    let parsed: ReturnType<typeof OwnedBrowserEvent.safeParse>;
    try {
      parsed = OwnedBrowserEvent.safeParse(JSON.parse(line));
    } catch {
      continue;
    }
    if (!parsed.success) continue;
    const key = `${parsed.data.pid}:${parsed.data.start_token}`;
    if (parsed.data.op === 'spawned') {
      outstanding.set(key, { pid: parsed.data.pid, startToken: parsed.data.start_token });
    } else {
      outstanding.delete(key);
    }
  }
  return [...outstanding.values()];
}
