import type { SensitiveScreenLatch } from './sensitive-screen-latch.js';

/** Why a fill holds protection while it runs. */
export type ProtectionHoldReason = 'masked_fill' | 'secret_fill';

/** What the focus guard last reported; `unknown` counts as protected (fail closed). */
export type ProtectedFocusState = 'clear' | 'protected' | 'unknown';

/** Releases one hold. Idempotent: a second call is a no-op. */
export type ProtectionRelease = () => void;

/** Receives the combined protection value on every transition. */
export type ScreenProtectionListener = (isProtected: boolean) => void;

/**
 * Whether the task page might show a secret right now (FEAT-069, plan §12).
 *
 * The screen is protected when **any** of these holds:
 * - the run's {@link SensitiveScreenLatch} is set (a secret was dispatched and
 *   the top-level document has not changed since);
 * - a fill hold is open (a deterministic secret or masked-value fill is in
 *   progress);
 * - the focus guard reports a protected control has focus, or cannot tell.
 *
 * Run-local, in memory, never persisted and never model-visible. The live
 * view is its only reader; nothing here changes how a run behaves.
 *
 * Listeners follow the same contract as the latch's: synchronous, only on a
 * change of the combined value, and a throwing listener does not stop the
 * others (the first error is rethrown after all ran).
 */
export class ScreenProtection {
  private latched: boolean;
  private holds = 0;
  private focus: ProtectedFocusState = 'clear';
  private current: boolean;
  private readonly listeners = new Set<ScreenProtectionListener>();

  public constructor(public readonly latch: SensitiveScreenLatch) {
    // An unreadable epoch never clears the latch, so this reads its raw state.
    this.latched = latch.isLatched(null);
    this.current = this.compute();
    latch.subscribe((latched) => {
      this.latched = latched;
      this.update();
    });
  }

  /** The combined value as of the last transition. Does not evaluate the epoch. */
  public get isProtectedNow(): boolean {
    return this.current;
  }

  /** The focus guard's last report. */
  public get focusState(): ProtectedFocusState {
    return this.focus;
  }

  /** Open fill holds. */
  public get openHolds(): number {
    return this.holds;
  }

  /**
   * Re-evaluates the latch against the current top-level epoch (which may
   * clear it) and returns the combined value.
   */
  public isProtected(currentTopLevelEpoch: number | null | undefined): boolean {
    this.latch.isLatched(currentTopLevelEpoch);
    return this.current;
  }

  /** Protects the screen until the returned release runs. Holds nest. */
  public hold(_reason: ProtectionHoldReason): ProtectionRelease {
    this.holds += 1;
    this.update();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holds -= 1;
      this.update();
    };
  }

  /** Records the focus guard's report. */
  public setFocus(state: ProtectedFocusState): void {
    if (this.focus === state) return;
    this.focus = state;
    this.update();
  }

  /** Follows the combined value's transitions; returns the unsubscribe function. */
  public subscribe(listener: ScreenProtectionListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private compute(): boolean {
    return this.latched || this.holds > 0 || this.focus !== 'clear';
  }

  private update(): void {
    const next = this.compute();
    if (next === this.current) return;
    this.current = next;
    let first: { readonly error: unknown } | null = null;
    for (const listener of [...this.listeners]) {
      try {
        listener(next);
      } catch (error) {
        first ??= { error };
      }
    }
    if (first !== null) throw first.error;
  }
}

/**
 * Runs `operation` under a fill hold, releasing it however the operation ends.
 * With no protection (a context that has none), runs the operation as is.
 */
export async function withProtectionHold<T>(
  protection: ScreenProtection | null | undefined,
  reason: ProtectionHoldReason,
  operation: () => Promise<T>,
): Promise<T> {
  if (!protection) return operation();
  const release = protection.hold(reason);
  try {
    return await operation();
  } finally {
    release();
  }
}
