import type { RunLease } from '@yantra/protocol';

import type { LivenessVerdict } from '../browser/installation-types.js';
import { ResourceBusyError } from '../locks/resource-lock.js';

/**
 * The run is owned by another process (or by one whose identity cannot be
 * verified). Exit 3, like every other busy resource. The message names the
 * holder's PID and origin, never the token or socket address.
 */
export class RunLeaseHeldError extends ResourceBusyError {
  public override readonly name = 'RunLeaseHeldError';
  public override readonly remediation: string;

  public constructor(
    public readonly runId: string,
    public readonly lease: RunLease | null,
    public readonly verdict: LivenessVerdict | 'corrupt',
  ) {
    super(
      { kind: 'run', runId },
      lease === null
        ? null
        : {
            pid: lease.owner.pid,
            command: `yantra ${lease.command.join(' ')}`,
            started_at: lease.claimed_at,
            surface: lease.origin,
          },
    );
    this.remediation =
      verdict === 'unknown'
        ? 'Its owner cannot be verified; wait for it to finish, or stop it, then try again.'
        : 'Wait for it to finish, or stop it, then try again.';
  }
}

/** The owner's identity cannot be verified, so nothing destructive is done. */
export class RunOwnerUnverifiableError extends Error {
  public override readonly name = 'RunOwnerUnverifiableError';

  public constructor(
    public readonly runId: string,
    public readonly pid: number,
  ) {
    super(`The owner of run ${runId} (pid ${pid}) cannot be verified; nothing was changed.`);
  }
}

export type RunOwnershipErrorCode =
  | 'RUN_OWNERSHIP_CLAIM_FAILED'
  | 'RUN_OWNERSHIP_SOCKET_DIR_UNSAFE'
  | 'RUN_OWNERSHIP_LEASE_UNREADABLE';

/** Any other ownership failure; `message` never carries the token or socket address. */
export class RunOwnershipError extends Error {
  public override readonly name = 'RunOwnershipError';

  public constructor(
    public readonly code: RunOwnershipErrorCode,
    message: string,
    options: { readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
  }
}
