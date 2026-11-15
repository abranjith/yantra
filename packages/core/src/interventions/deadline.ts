export const UNATTENDED_CEILING_MS = 900_000 as const;

export type DeadlineBasis = 'request_timeout' | 'agent_confirm_timeout' | 'wall_clock' | 'none';

type InstantInput = string | number | Date;

export interface AttendedDeadlineInput {
  readonly requestedAt: InstantInput;
  readonly timeoutMs: number | null;
  readonly agentConfirmTimeoutMs: number | null;
  readonly wallClockDeadlineAt: InstantInput | null;
}

export interface AttendedDeadline {
  readonly attendedDeadlineAt: string | null;
  readonly basis: DeadlineBasis;
}

/** Return the earliest attended deadline, preserving which bound won. */
export function computeAttendedDeadline(input: AttendedDeadlineInput): AttendedDeadline {
  const requestedAt = toEpoch(input.requestedAt);
  if (requestedAt === null) return { attendedDeadlineAt: null, basis: 'none' };

  const candidates: { readonly at: number; readonly basis: Exclude<DeadlineBasis, 'none'> }[] = [];
  if (input.timeoutMs !== null) {
    candidates.push({ at: requestedAt + input.timeoutMs, basis: 'request_timeout' });
  }
  if (input.agentConfirmTimeoutMs !== null) {
    candidates.push({
      at: requestedAt + input.agentConfirmTimeoutMs,
      basis: 'agent_confirm_timeout',
    });
  }
  const wallClock = input.wallClockDeadlineAt === null ? null : toEpoch(input.wallClockDeadlineAt);
  if (wallClock !== null) candidates.push({ at: wallClock, basis: 'wall_clock' });
  if (candidates.length === 0) return { attendedDeadlineAt: null, basis: 'none' };

  const earliest = candidates.reduce((best, candidate) =>
    candidate.at < best.at ? candidate : best,
  );
  return { attendedDeadlineAt: new Date(earliest.at).toISOString(), basis: earliest.basis };
}

export interface UnattendedCeilingClockOptions {
  readonly seedAccruedMs?: number;
  readonly ceilingMs?: number;
  readonly now: () => number;
}

/** Tracks cumulative unattended time using absolute clock instants. */
export class UnattendedCeilingClock {
  private readonly ceilingMs: number;
  private accruedMs: number;
  private unattendedSince: number | null;
  private attendanceCount = 0;

  private readonly now: () => number;

  public constructor(options: UnattendedCeilingClockOptions) {
    this.ceilingMs = options.ceilingMs ?? UNATTENDED_CEILING_MS;
    this.accruedMs = Math.max(0, options.seedAccruedMs ?? 0);
    this.now = options.now;
    this.unattendedSince = this.now();
  }

  public setAttendance(count: number): void {
    const next = Math.max(0, Math.trunc(count));
    if (this.attendanceCount === 0 && next > 0) {
      this.accruedMs = this.accrued(this.now());
      this.unattendedSince = null;
    } else if (this.attendanceCount > 0 && next === 0) {
      this.unattendedSince = this.now();
    }
    this.attendanceCount = next;
  }

  public accrued(now = this.now()): number {
    if (this.unattendedSince === null) return this.accruedMs;
    return this.accruedMs + Math.max(0, now - this.unattendedSince);
  }

  public ceilingDeadlineAt(now = this.now()): number | null {
    if (this.attendanceCount > 0) return null;
    return now + Math.max(0, this.ceilingMs - this.accrued(now));
  }

  public isExpired(now = this.now()): boolean {
    return this.accrued(now) >= this.ceilingMs;
  }

  public attendance(): number {
    return this.attendanceCount;
  }
}

/** Return the earlier attended or unattended deadline as an ISO timestamp. */
export function effectiveDeadlineAt(
  attendedDeadlineAt: string | null,
  clock: UnattendedCeilingClock,
  now: number,
): string | null {
  const unattended = clock.ceilingDeadlineAt(now);
  const attended = attendedDeadlineAt === null ? null : toEpoch(attendedDeadlineAt);
  if (attended === null && unattended === null) return null;
  if (attended === null) return new Date(unattended!).toISOString();
  if (unattended === null) return new Date(attended).toISOString();
  return new Date(Math.min(attended, unattended)).toISOString();
}

function toEpoch(value: InstantInput): number | null {
  const epoch =
    value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(epoch) ? epoch : null;
}
