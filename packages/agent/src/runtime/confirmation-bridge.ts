import type { ConfirmationGateway, ConfirmationStore } from '@yantra/core';
import type { ConfirmationDecision, ConfirmationRequest } from '@yantra/protocol';

/** Connector surface needed to resolve a live agent confirmation. */
export interface ConfirmationConnector {
  /** False for JSON, scheduled, daemon, and non-TTY surfaces. */
  readonly interactive: boolean;
  /**
   * Present a confirmation and resolve the human response.
   *
   * @param request Structured action, host, and consequence summary.
   * @param signal Aborted on timeout, run abort, or wall-clock expiry.
   * @returns A human grant or denial. Agents can never call this method.
   */
  requestConfirmation(
    request: ConfirmationRequest,
    signal: AbortSignal,
  ): Promise<'granted' | 'denied'>;
}

/** Configuration and dependencies for {@link ConfirmationBridge}. */
export interface ConfirmationBridgeOptions {
  readonly connector: ConfirmationConnector;
  /** Maximum time a live prompt may wait before failing closed. */
  readonly timeoutMs: number;
  /** Whole-run abort signal (interrupt or budget exhaustion). */
  readonly runSignal: AbortSignal;
  /** Current wall-clock budget remaining; checked at each request. */
  readonly remainingWallClockMs: () => number;
  /** Optional durable audit store for request/decision linkage. */
  readonly store?: ConfirmationStore | null;
  readonly nowIso?: () => string;
}

/**
 * Raised when a pending confirmation is canceled by the owning run. The tool
 * middleware genericizes the in-flight call, while the orchestrator's abort
 * state remains authoritative for the terminal run outcome.
 */
export class ConfirmationWaitAbortedError extends Error {
  public readonly code: 'AGENT_ABORTED' | 'AGENT_BUDGET_EXHAUSTED';

  public constructor(public readonly reason: 'run-abort' | 'wall-clock') {
    super(
      reason === 'wall-clock'
        ? 'The run wall-clock budget expired while confirmation was pending.'
        : 'The run was aborted while confirmation was pending.',
    );
    this.name = 'ConfirmationWaitAbortedError';
    this.code = reason === 'wall-clock' ? 'AGENT_BUDGET_EXHAUSTED' : 'AGENT_ABORTED';
  }
}

/**
 * Adapts a live ConnectorIO confirmation surface to core's
 * {@link ConfirmationGateway}. The wait is bounded, abort-aware, fail-closed,
 * and optionally writes both sides of the confirmation audit linkage.
 */
export class ConfirmationBridge implements ConfirmationGateway {
  private readonly nowIso: () => string;

  public constructor(private readonly options: ConfirmationBridgeOptions) {
    this.nowIso = options.nowIso ?? (() => new Date().toISOString());
  }

  /**
   * Present one protected action and wait for a bounded human decision.
   *
   * @param request Core confirmation request generated immediately before the action.
   * @returns A grant, denial, or fail-closed timeout decision.
   */
  public async request(request: ConfirmationRequest): Promise<ConfirmationDecision> {
    await this.options.store?.appendRequest(request);

    if (!this.options.connector.interactive) {
      const decision = this.makeDecision(request, 'timed_out', 'timeout');
      await this.options.store?.appendDecision(decision);
      return decision;
    }

    const remaining = Math.max(0, Math.floor(this.options.remainingWallClockMs()));
    if (remaining === 0 || this.options.runSignal.aborted) {
      throw new ConfirmationWaitAbortedError(remaining === 0 ? 'wall-clock' : 'run-abort');
    }

    const configuredWait = Math.max(1, Math.floor(this.options.timeoutMs));
    const requestedWait = request.timeout_ms ?? configuredWait;
    const confirmationWait = Math.min(configuredWait, requestedWait);
    const controller = new AbortController();
    const cleanup: (() => void)[] = [];

    try {
      const response = await Promise.race([
        this.options.connector.requestConfirmation(request, controller.signal),
        this.abortRace(this.options.runSignal, controller, cleanup),
        this.wallClockRace(remaining, confirmationWait, cleanup),
        this.timeoutRace(confirmationWait, remaining, cleanup),
      ]);
      const decision = this.makeDecision(
        request,
        response === 'granted' ? 'granted' : 'denied',
        'user_interactive',
      );
      await this.options.store?.appendDecision(decision);
      return decision;
    } catch (error) {
      if (error instanceof ConfirmationTimeoutSignal) {
        const decision = this.makeDecision(request, 'timed_out', 'timeout');
        await this.options.store?.appendDecision(decision);
        return decision;
      }
      throw error;
    } finally {
      controller.abort('confirmation-settled');
      for (const dispose of cleanup) dispose();
    }
  }

  private abortRace(
    signal: AbortSignal,
    controller: AbortController,
    cleanup: (() => void)[],
  ): Promise<never> {
    return new Promise((_, reject) => {
      const onAbort = (): void => {
        controller.abort('run-abort');
        reject(new ConfirmationWaitAbortedError('run-abort'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      cleanup.push(() => signal.removeEventListener('abort', onAbort));
    });
  }

  private wallClockRace(
    remainingMs: number,
    confirmationWaitMs: number,
    cleanup: (() => void)[],
  ): Promise<never> {
    if (remainingMs > confirmationWaitMs) return new Promise(() => undefined);
    return timerRace(remainingMs, cleanup, () => {
      return new ConfirmationWaitAbortedError('wall-clock');
    });
  }

  private timeoutRace(
    confirmationWaitMs: number,
    remainingMs: number,
    cleanup: (() => void)[],
  ): Promise<never> {
    if (remainingMs <= confirmationWaitMs) return new Promise(() => undefined);
    return timerRace(confirmationWaitMs, cleanup, () => {
      return new ConfirmationTimeoutSignal();
    });
  }

  private makeDecision(
    request: ConfirmationRequest,
    decision: ConfirmationDecision['decision'],
    decidedBy: ConfirmationDecision['decided_by'],
  ): ConfirmationDecision {
    return {
      confirmation_id: request.confirmation_id,
      decision,
      decided_at: this.nowIso(),
      decided_by: decidedBy,
    };
  }
}

class ConfirmationTimeoutSignal extends Error {}

function timerRace(ms: number, cleanup: (() => void)[], error: () => Error): Promise<never> {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(error()), Math.max(1, ms));
    timer.unref?.();
    cleanup.push(() => clearTimeout(timer));
  });
}
