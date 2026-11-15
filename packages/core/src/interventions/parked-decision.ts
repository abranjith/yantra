import { randomBytes } from 'node:crypto';
import { chmod, link, mkdir, open, readFile, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  ParkedDecisionClaim,
  type ConfirmationDecision,
  type DecisionResponse,
  type ParkedDecisionClaim as ParkedDecisionClaimType,
} from '@yantra/protocol';
import lockfile from 'proper-lockfile';

import { ConfirmationStore } from '../executor/confirmation-gateway.js';

import { bindingOf } from './binding.js';

export interface DecideParkedInput {
  readonly runDir: string;
  readonly runId: string;
  readonly decision: 'granted' | 'denied';
  readonly decidedBy: 'user_cli_confirm' | 'user_app';
  readonly now?: string;
}

interface ClaimRead {
  readonly claim: ParkedDecisionClaimType | null;
  readonly corrupt: boolean;
}

/**
 * The durable decision authority for runs without a live owner.
 *
 * A claim is published with an exclusive hard-link operation. The claim is
 * authoritative; `confirmations.jsonl` is a repairable projection for the
 * existing readers and reports.
 */
export class ParkedDecisionService {
  async decideParked(input: DecideParkedInput): Promise<DecisionResponse> {
    const store = new ConfirmationStore(join(input.runDir, 'confirmations.jsonl'));
    await this.repairClaimProjection(input.runDir);

    const pending = await store.findPending(input.runId);
    if (pending === null) {
      const latest = await store.latestRequest(input.runId);
      const prior = latest === null ? null : await store.latestDecision(input.runId);
      if (prior !== null) return alreadyDecidedFromDecision(prior);
      return { status: 'stale', reason: 'not_waiting' };
    }

    const decidedAt = input.now ?? new Date().toISOString();
    const claim: ParkedDecisionClaimType = {
      schema_version: 1,
      confirmation_id: pending.confirmation_id,
      run_id: input.runId,
      decision: input.decision,
      decided_by: input.decidedBy,
      decided_at: decidedAt,
      binding: bindingOf(pending),
    };

    const claimPath = this.claimPath(input.runDir, pending.confirmation_id);
    try {
      await publishExclusive(claimPath, `${JSON.stringify(claim)}\n`);
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const prior = await readClaim(claimPath);
      return alreadyDecidedResponse(prior);
    }

    const decision: ConfirmationDecision = {
      confirmation_id: claim.confirmation_id,
      decision: claim.decision,
      decided_at: claim.decided_at,
      decided_by: claim.decided_by,
    };
    await appendProjectionIfMissing(input.runDir, decision);
    return { status: 'accepted', decision };
  }

  /** Read a claim; malformed claims are returned as a fail-closed corrupt result. */
  async readClaim(runDir: string, confirmationId: string): Promise<ParkedDecisionClaimType | null> {
    const result = await readClaim(this.claimPath(runDir, confirmationId));
    return result.claim;
  }

  /** Repair missing confirmation projection lines from authoritative claims. */
  async repairClaimProjection(runDir: string): Promise<void> {
    const decisionsDir = join(runDir, 'decisions');
    let names: string[];
    try {
      names = await readdir(decisionsDir);
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }

    const store = new ConfirmationStore(join(runDir, 'confirmations.jsonl'));
    const entries = await store.readAll();
    const projected = new Set(
      entries
        .filter(
          (entry): entry is { kind: 'decision'; data: ConfirmationDecision } =>
            entry.kind === 'decision',
        )
        .map((entry) => entry.data.confirmation_id),
    );

    for (const name of names.filter((candidate) => candidate.endsWith('.json'))) {
      const confirmationId = name.slice(0, -'.json'.length);
      if (projected.has(confirmationId)) continue;
      const result = await readClaim(join(decisionsDir, name));
      const decision = result.claim
        ? claimToDecision(result.claim)
        : corruptClaimToDecision(confirmationId);
      await appendProjectionIfMissing(runDir, decision);
      projected.add(confirmationId);
    }
  }

  private claimPath(runDir: string, confirmationId: string): string {
    return join(runDir, 'decisions', `${confirmationId}.json`);
  }
}

function claimToDecision(claim: ParkedDecisionClaimType): ConfirmationDecision {
  return {
    confirmation_id: claim.confirmation_id,
    decision: claim.decision,
    decided_at: claim.decided_at,
    decided_by: claim.decided_by,
  };
}

function corruptClaimToDecision(confirmationId: string): ConfirmationDecision {
  return {
    confirmation_id: confirmationId,
    decision: 'denied',
    decided_at: new Date(0).toISOString(),
    decided_by: 'user_cli_confirm',
  };
}

function alreadyDecidedFromDecision(decision: ConfirmationDecision): DecisionResponse {
  return {
    status: 'already_decided',
    decision: decision.decision,
    decided_by: decision.decided_by,
    decided_at: decision.decided_at,
  };
}

function alreadyDecidedResponse(result: ClaimRead): DecisionResponse {
  if (result.claim !== null) {
    return {
      status: 'already_decided',
      decision: result.claim.decision,
      decided_by: result.claim.decided_by,
      decided_at: result.claim.decided_at,
    };
  }
  return {
    status: 'already_decided',
    decision: 'denied',
    decided_by: 'user_cli_confirm',
    decided_at: new Date(0).toISOString(),
  };
}

async function readClaim(path: string): Promise<ClaimRead> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (isNotFound(error)) return { claim: null, corrupt: false };
    throw error;
  }
  try {
    return { claim: ParkedDecisionClaim.parse(JSON.parse(raw)), corrupt: false };
  } catch {
    return { claim: null, corrupt: true };
  }
}

async function appendProjectionIfMissing(
  runDir: string,
  decision: ConfirmationDecision,
): Promise<void> {
  const release = await lockfile.lock(runDir, {
    retries: { retries: 80, factor: 1, minTimeout: 25, maxTimeout: 25 },
    stale: 10_000,
  });
  try {
    const store = new ConfirmationStore(join(runDir, 'confirmations.jsonl'));
    const alreadyProjected = (await store.readAll()).some(
      (entry) =>
        entry.kind === 'decision' && entry.data.confirmation_id === decision.confirmation_id,
    );
    if (!alreadyProjected) await store.appendDecision(decision);
  } finally {
    await release();
  }
}

async function publishExclusive(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  let staged = false;
  try {
    const file = await open(temporary, 'wx', 0o600);
    staged = true;
    try {
      await file.writeFile(data, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await link(temporary, path);
    } catch (error) {
      if (!isUnsupportedLink(error)) throw error;
      const destination = await open(path, 'wx', 0o600);
      try {
        await destination.writeFile(data, 'utf8');
        await destination.sync();
      } finally {
        await destination.close();
      }
    }
    try {
      await chmod(path, 0o600);
    } catch {
      // chmod is best-effort on platforms without POSIX modes.
    }
  } finally {
    if (staged) await rm(temporary, { force: true });
  }
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'EEXIST';
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function isUnsupportedLink(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'EPERM' || code === 'ENOSYS' || code === 'EOPNOTSUPP';
}
