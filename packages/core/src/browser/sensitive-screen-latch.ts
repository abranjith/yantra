/** Receives the latch's state on every transition (`true` latched, `false` cleared). */
export type SensitiveScreenLatchListener = (latched: boolean) => void;

/**
 * Run-local guard set before a resolved secret can reach a browser page.
 * Only a verified top-level document epoch change or teardown clears it.
 *
 * Observable (FEAT-069): {@link subscribe} pushes every transition, so the
 * live view can hide the screen the instant a secret is about to be typed.
 * Listeners run synchronously **after** the state changes. A listener must not
 * throw; if one does, the remaining listeners still run and the first error is
 * rethrown from the call that caused the transition. Inside `latch()` that
 * fails the fill closed, because the latch is set before any character is
 * dispatched.
 */
export class SensitiveScreenLatch {
  private latched = false;
  private latchedAtEpoch: number | null = null;
  private readonly listeners = new Set<SensitiveScreenLatchListener>();

  /** Latch before secret dispatch. An unreadable epoch deliberately remains fail-closed. */
  public latch(epoch: number | null | undefined): void {
    const was = this.latched;
    this.latched = true;
    this.latchedAtEpoch = validEpoch(epoch) ? epoch : null;
    if (!was) this.notify(true);
  }

  /** True while the same top-level document might still display the secret. */
  public isLatched(currentTopLevelEpoch: number | null | undefined): boolean {
    if (!this.latched) return false;
    if (!validEpoch(currentTopLevelEpoch) || this.latchedAtEpoch === null) return true;
    if (currentTopLevelEpoch === this.latchedAtEpoch) return true;
    this.latched = false;
    this.latchedAtEpoch = null;
    this.notify(false);
    return false;
  }

  /** Clears run-local state when its browser is torn down. */
  public clearOnTeardown(): void {
    const was = this.latched;
    this.latched = false;
    this.latchedAtEpoch = null;
    if (was) this.notify(false);
  }

  /**
   * Follows the latch's transitions. Delivery is synchronous and only on a
   * change: re-latching while latched, or reading the same epoch again, does
   * not notify. Returns the unsubscribe function.
   */
  public subscribe(listener: SensitiveScreenLatchListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(latched: boolean): void {
    let first: { readonly error: unknown } | null = null;
    for (const listener of [...this.listeners]) {
      try {
        listener(latched);
      } catch (error) {
        first ??= { error };
      }
    }
    if (first !== null) throw first.error;
  }
}

function validEpoch(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
