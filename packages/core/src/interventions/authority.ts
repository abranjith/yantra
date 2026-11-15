import type {
  ConfirmationDecidedBy,
  ConfirmationRequest,
  DecisionResponse,
  Intervention,
  InterventionLogEntry,
  InterventionResolutionReason,
  RunEvent,
} from '@yantra/protocol';

import type { GatewayDecision } from '../executor/confirmation-gateway.js';

import {
  computeAttendedDeadline,
  effectiveDeadlineAt,
  type UnattendedCeilingClock,
} from './deadline.js';
import type { InterventionLog } from './intervention-log.js';

export interface InterventionEventSink {
  publish(event: RunEvent): void;
  flush(): Promise<void>;
}

export interface InterventionRuntimeLog {
  append?(event: Record<string, unknown>): Promise<void> | void;
  write?(event: Record<string, unknown>): Promise<void> | void;
}

export interface InterventionClock {
  now(): string;
}

export interface InterventionTimers {
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

export interface InterventionAuthorityOptions {
  readonly runId: string;
  readonly log: InterventionLog;
  readonly events: InterventionEventSink;
  readonly runtimeLog?: InterventionRuntimeLog;
  readonly clock: InterventionClock;
  readonly timers?: InterventionTimers;
  readonly ceiling: UnattendedCeilingClock;
}

export interface RaiseOptions {
  readonly agentConfirmTimeoutMs?: number | null;
  readonly wallClockDeadlineAt?: string | null;
}

export interface AnswerInput {
  readonly interventionId: string;
  readonly decision: 'granted' | 'denied';
  readonly decidedBy: ConfirmationDecidedBy;
}

type State = 'pending' | 'deciding' | 'resolved';

interface PendingIntervention {
  readonly intervention: Intervention;
  readonly resolve: (decision: GatewayDecision) => void;
  readonly reject: (error: unknown) => void;
  readonly raisedAtMs: number;
  state: State;
  decision: GatewayDecision | null;
  persistPromise: Promise<void> | null;
  timer: ReturnType<typeof setTimeout> | null;
}

const defaultTimers: InterventionTimers = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle),
};

/** Sole live-run decision authority. */
export class InterventionAuthority {
  private readonly timers: InterventionTimers;
  private readonly pending = new Map<string, PendingIntervention>();
  private readonly raisedListeners = new Set<(intervention: Intervention) => void>();
  private readonly resolvedListeners = new Set<(interventionId: string) => void>();
  private readonly attendanceListeners = new Set<(count: number) => void>();

  public constructor(private readonly options: InterventionAuthorityOptions) {
    this.timers = options.timers ?? defaultTimers;
  }

  /** Current number of attending windows. */
  public attendance(): number {
    return this.options.ceiling.attendance();
  }

  /** Observe raises without affecting the decision path. */
  public onRaised(listener: (intervention: Intervention) => void): () => void {
    this.raisedListeners.add(listener);
    return () => this.raisedListeners.delete(listener);
  }

  /** Observe resolutions without affecting the decision path. */
  public onResolved(listener: (interventionId: string) => void): () => void {
    this.resolvedListeners.add(listener);
    return () => this.resolvedListeners.delete(listener);
  }

  /** Observe attendance changes without affecting the decision path. */
  public onAttendance(listener: (count: number) => void): () => void {
    this.attendanceListeners.add(listener);
    return () => this.attendanceListeners.delete(listener);
  }

  /** Register and durably raise a consent, returning its eventual decision. */
  public raise(request: ConfirmationRequest, limits: RaiseOptions = {}): Promise<GatewayDecision> {
    const raisedAt = this.options.clock.now();
    const attended = computeAttendedDeadline({
      requestedAt: raisedAt,
      timeoutMs: request.timeout_ms,
      agentConfirmTimeoutMs: limits.agentConfirmTimeoutMs ?? null,
      wallClockDeadlineAt: limits.wallClockDeadlineAt ?? null,
    });
    const intervention: Intervention = {
      intervention_id: request.confirmation_id,
      run_id: this.options.runId,
      kind: 'consent',
      state: 'pending',
      raised_at: raisedAt,
      request,
      attended_deadline_at: attended.attendedDeadlineAt,
      deadline_basis: attended.basis,
      unattended_ceiling_ms: 900_000,
      unattended_accrued_ms: this.options.ceiling.accrued(this.nowMs()),
      handoff: null,
      missing: null,
      recovery: 'resume',
    };

    let resolveWait!: (decision: GatewayDecision) => void;
    let rejectWait!: (error: unknown) => void;
    const wait = new Promise<GatewayDecision>((resolve, reject) => {
      resolveWait = resolve;
      rejectWait = reject;
    });
    const state: PendingIntervention = {
      intervention,
      resolve: resolveWait,
      reject: rejectWait,
      raisedAtMs: this.nowMs(),
      state: 'pending',
      decision: null,
      persistPromise: null,
      timer: null,
    };
    this.pending.set(request.confirmation_id, state);

    void this.persistRaised(state).then(
      () => {
        for (const listener of this.raisedListeners) listener(state.intervention);
        this.armTimer(state);
      },
      (error: unknown) => {
        this.pending.delete(request.confirmation_id);
        state.reject(error);
      },
    );
    return wait;
  }

  /** Atomically answer or timeout one pending intervention. */
  public async answer(input: AnswerInput): Promise<DecisionResponse> {
    const state = this.pending.get(input.interventionId);
    if (state === undefined) return { status: 'stale', reason: 'unknown_id' };

    if (state.state === 'pending' && this.isExpired(state)) {
      const reason = this.expiryReason(state);
      await this.beginResolution(
        state,
        {
          decision: 'timed_out',
          decided_by: 'timeout',
          expiryReason: reason,
          ...(reason === 'unattended' ? { blocker: this.unattendedBlocker(state) } : {}),
        },
        reason,
      );
      return { status: 'expired', decided_at: state.decision!.decided_at };
    }

    if (state.state === 'pending') {
      await this.beginResolution(
        state,
        {
          confirmation_id: input.interventionId,
          decision: input.decision,
          decided_at: this.options.clock.now(),
          decided_by: input.decidedBy,
        },
        'answered',
      );
      return { status: 'accepted', decision: state.decision! };
    }

    if (state.persistPromise !== null) await state.persistPromise;
    const decision = state.decision!;
    return {
      status: 'already_decided',
      decision: decision.decision,
      decided_by: decision.decided_by,
      decided_at: decision.decided_at,
    };
  }

  /** Update attendance and re-arm all pending intervention deadlines. */
  public async setAttendance(count: number): Promise<void> {
    const previous = this.options.ceiling.attendance();
    this.options.ceiling.setAttendance(count);
    if ((previous === 0) !== (this.options.ceiling.attendance() === 0)) {
      const entry: InterventionLogEntry = {
        entry: 'attendance',
        count: this.options.ceiling.attendance(),
        at: this.options.clock.now(),
      };
      await this.options.log.append(entry);
      this.options.events.publish({
        kind: 'attendance_changed',
        run_id: this.options.runId,
        count: this.options.ceiling.attendance(),
        at: entry.at,
      } as unknown as RunEvent);
      await this.options.events.flush();
    }
    for (const listener of this.attendanceListeners) listener(this.options.ceiling.attendance());
    for (const state of this.pending.values()) this.armTimer(state);
  }

  /** Resolve all pending waits before the owner exits. */
  public async close(reason: 'run_ended' = 'run_ended'): Promise<void> {
    for (const state of [...this.pending.values()]) {
      if (state.state === 'pending') {
        await this.beginResolution(
          state,
          {
            decision: 'timed_out',
            decided_by: 'timeout',
            expiryReason: 'wall_clock',
          },
          reason,
        );
      } else if (state.persistPromise !== null) {
        await state.persistPromise;
      }
    }
  }

  private async beginResolution(
    state: PendingIntervention,
    partial: Omit<GatewayDecision, 'confirmation_id' | 'decided_at'> &
      Partial<Pick<GatewayDecision, 'confirmation_id' | 'decided_at'>>,
    reason: InterventionResolutionReason,
  ): Promise<void> {
    if (state.state !== 'pending') {
      if (state.persistPromise !== null) await state.persistPromise;
      return;
    }
    state.state = 'deciding';
    const decision: GatewayDecision = {
      confirmation_id: partial.confirmation_id ?? state.intervention.intervention_id,
      decision: partial.decision,
      decided_at: partial.decided_at ?? this.options.clock.now(),
      decided_by: partial.decided_by,
      ...(partial.blocker === undefined ? {} : { blocker: partial.blocker }),
      ...(partial.expiryReason === undefined ? {} : { expiryReason: partial.expiryReason }),
    };
    state.decision = decision;
    state.persistPromise = this.persistResolved(state, decision, reason);
    try {
      await state.persistPromise;
    } catch (error) {
      state.state = 'pending';
      state.decision = null;
      state.persistPromise = null;
      this.armTimer(state);
      throw error;
    }
    state.state = 'resolved';
    this.pending.delete(state.intervention.intervention_id);
    if (state.timer !== null) this.timers.clearTimeout(state.timer);
    for (const listener of this.resolvedListeners) listener(state.intervention.intervention_id);
    state.resolve(decision);
  }

  private async persistRaised(state: PendingIntervention): Promise<void> {
    await this.options.log.append({ entry: 'raised', intervention: state.intervention });
    this.options.events.publish({
      kind: 'intervention_raised',
      intervention_id: state.intervention.intervention_id,
      intervention_kind: 'confirmation',
      request: state.intervention.request!,
      deadline_at: state.intervention.attended_deadline_at ?? null,
      at: state.intervention.raised_at,
    });
    await this.options.events.flush();
    await this.writeRuntime({
      kind: 'intervention_raised',
      intervention_kind: 'consent',
      run_id: this.options.runId,
    });
  }

  private async persistResolved(
    state: PendingIntervention,
    decision: GatewayDecision,
    reason: InterventionResolutionReason,
  ): Promise<void> {
    const entry: InterventionLogEntry = {
      entry: 'resolved',
      intervention_id: state.intervention.intervention_id,
      decision,
      reason,
      waited_ms: Math.max(0, this.nowMs() - state.raisedAtMs),
      unattended_accrued_ms: this.options.ceiling.accrued(this.nowMs()),
    };
    await this.options.log.append(entry);
    this.options.events.publish({
      kind: 'intervention_resolved',
      intervention_id: entry.intervention_id,
      decision: decision.decision,
      decided_by: decision.decided_by,
      decided_at: decision.decided_at,
      at: this.options.clock.now(),
    });
    await this.options.events.flush();
    await this.writeRuntime({
      kind: 'intervention_resolved',
      intervention_kind: 'consent',
      decided_by: decision.decided_by,
      waited_ms: entry.waited_ms,
    });
  }

  private armTimer(state: PendingIntervention): void {
    if (state.state !== 'pending') return;
    if (state.timer !== null) this.timers.clearTimeout(state.timer);
    const deadline = effectiveDeadlineAt(
      state.intervention.attended_deadline_at ?? null,
      this.options.ceiling,
      this.nowMs(),
    );
    if (deadline === null) return;
    const delay = Math.max(0, Date.parse(deadline) - this.nowMs());
    state.timer = this.timers.setTimeout(() => {
      void this.timeout(state);
    }, delay);
  }

  private async timeout(state: PendingIntervention): Promise<void> {
    if (state.state !== 'pending' || !this.isExpired(state)) return;
    const reason = this.expiryReason(state);
    await this.beginResolution(
      state,
      {
        decision: 'timed_out',
        decided_by: 'timeout',
        expiryReason: reason,
        ...(reason === 'unattended'
          ? {
              blocker: `No one was available to approve ${state.intervention.request!.action_kind} on ${state.intervention.request!.host} within 15 minutes.`,
            }
          : {}),
      },
      reason,
    );
  }

  private isExpired(state: PendingIntervention): boolean {
    const deadline = effectiveDeadlineAt(
      state.intervention.attended_deadline_at ?? null,
      this.options.ceiling,
      this.nowMs(),
    );
    return deadline !== null && this.nowMs() >= Date.parse(deadline);
  }

  private expiryReason(
    state: PendingIntervention,
  ): Exclude<InterventionResolutionReason, 'answered' | 'run_ended'> {
    if (this.options.ceiling.isExpired(this.nowMs())) return 'unattended';
    const basis = state.intervention.deadline_basis;
    return basis === 'request_timeout' ||
      basis === 'agent_confirm_timeout' ||
      basis === 'wall_clock'
      ? basis
      : 'wall_clock';
  }

  private unattendedBlocker(state: PendingIntervention): string {
    const request = state.intervention.request!;
    return `No one was available to approve ${request.action_kind} on ${request.host} within 15 minutes.`;
  }

  private nowMs(): number {
    return Date.parse(this.options.clock.now());
  }

  private async writeRuntime(event: Record<string, unknown>): Promise<void> {
    if (this.options.runtimeLog?.append) await this.options.runtimeLog.append(event);
    else if (this.options.runtimeLog?.write) await this.options.runtimeLog.write(event);
  }
}
