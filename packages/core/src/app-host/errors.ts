import type { HostLockRecord, InvocationState } from '@yantra/protocol';

/**
 * Another app host holds `host.lock` for this data directory.
 *
 * - `record` set, `uncertain` false: the holder is alive; reuse that host.
 * - `uncertain` true: the holder's identity cannot be verified (`unknown`) or
 *   the record is unreadable. Nothing is reclaimed (memory → Architecture).
 */
export class HostLockHeldError extends Error {
  public override readonly name = 'HostLockHeldError';
  public readonly remediation: string;

  public constructor(
    public readonly record: HostLockRecord | null,
    public readonly uncertain: boolean,
    lockPath: string,
  ) {
    super(
      record === null
        ? `The app host lock at ${lockPath} cannot be read.`
        : uncertain
          ? `An app host (pid ${record.pid}) holds the lock, but whether it is still running cannot be verified.`
          : `An app host is already running (pid ${record.pid}).`,
    );
    this.remediation = uncertain
      ? `Close any running Yantra app; if none is running, delete ${lockPath} and run \`yantra ui\` again.`
      : 'Use the running app host.';
  }
}

/** An invocation-record move the D11 transition table does not allow. */
export class InvalidInvocationTransition extends Error {
  public override readonly name = 'InvalidInvocationTransition';

  public constructor(
    public readonly invocationId: string,
    public readonly from: InvocationState,
    public readonly to: InvocationState,
  ) {
    super(`Invocation ${invocationId} cannot move from ${from} to ${to}.`);
  }
}

/**
 * A worker's claim was refused because the invocation was withdrawn
 * (`never_started` or `discarded`). The worker exits with no side effects.
 */
export class ClaimRefusedError extends Error {
  public override readonly name = 'ClaimRefusedError';

  public constructor(
    public readonly invocationId: string,
    public readonly state: InvocationState,
  ) {
    super(`Invocation ${invocationId} is ${state}; this worker does not own it.`);
  }
}

/** `slots.lock` stayed held past the bounded wait; nothing was written (D14). */
export class SlotLockBusyError extends Error {
  public override readonly name = 'SlotLockBusyError';
  public readonly remediation = 'Another Yantra process is updating the app queue; try again.';

  public constructor() {
    super('The app queue is busy.');
  }
}
