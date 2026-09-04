/**
 * Run-local guard set before a resolved secret can reach a browser page.
 * Only a verified top-level document epoch change or teardown clears it.
 */
export class SensitiveScreenLatch {
  private latched = false;
  private latchedAtEpoch: number | null = null;

  /** Latch before secret dispatch. An unreadable epoch deliberately remains fail-closed. */
  public latch(epoch: number | null | undefined): void {
    this.latched = true;
    this.latchedAtEpoch = validEpoch(epoch) ? epoch : null;
  }

  /** True while the same top-level document might still display the secret. */
  public isLatched(currentTopLevelEpoch: number | null | undefined): boolean {
    if (!this.latched) return false;
    if (!validEpoch(currentTopLevelEpoch) || this.latchedAtEpoch === null) return true;
    if (currentTopLevelEpoch === this.latchedAtEpoch) return true;
    this.latched = false;
    this.latchedAtEpoch = null;
    return false;
  }

  /** Clears run-local state when its browser is torn down. */
  public clearOnTeardown(): void {
    this.latched = false;
    this.latchedAtEpoch = null;
  }
}

function validEpoch(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
