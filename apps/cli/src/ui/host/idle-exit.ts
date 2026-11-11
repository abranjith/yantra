/**
 * Idle exit (FEAT-065 TASK-018, §8 reliability matrix).
 *
 * When no window is connected and no invocation is `queued`, `reserved` or
 * `spawning`, a 10-minute timer starts; a connection or a new invocation
 * cancels it. When it fires the host shuts down gracefully. `claimed` and
 * `running` workers neither block the exit nor are touched: they own their
 * runs and outlive the host (D6).
 */

/** How long the host stays up with nothing to do. */
export const IDLE_EXIT_MS = 10 * 60_000;

/** What decides whether the host is idle. */
export interface IdleSignals {
  /** Windows with an open socket. */
  connectedWindows(): number;
  /** True while an invocation is queued, reserved or spawning. */
  pendingStarts(): Promise<boolean>;
}

export interface IdleExitDeps {
  readonly signals: IdleSignals;
  /** Shuts the host down. */
  readonly onIdle: () => void;
  readonly timers?: {
    setTimeout(callback: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
  };
  readonly idleMs?: number;
}

/** See the module comment. */
export class IdleExit {
  private timer: unknown = null;
  private fired = false;

  public constructor(private readonly deps: IdleExitDeps) {}

  /** True while the countdown runs. */
  public get counting(): boolean {
    return this.timer !== null;
  }

  /** Starts or cancels the countdown for the current state. */
  public async check(): Promise<void> {
    if (this.fired) return;
    const idle =
      this.deps.signals.connectedWindows() === 0 && !(await this.deps.signals.pendingStarts());
    const timers = this.deps.timers ?? {
      setTimeout: (callback: () => void, ms: number) => {
        const handle = setTimeout(callback, ms);
        handle.unref();
        return handle;
      },
      clearTimeout: (handle: unknown) => {
        clearTimeout(handle as NodeJS.Timeout);
      },
    };
    if (idle && this.timer === null) {
      this.timer = timers.setTimeout(() => {
        this.timer = null;
        this.fired = true;
        this.deps.onIdle();
      }, this.deps.idleMs ?? IDLE_EXIT_MS);
    } else if (!idle && this.timer !== null) {
      timers.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Stops the countdown for good (shutdown already under way). */
  public cancel(): void {
    if (this.timer !== null) (this.deps.timers?.clearTimeout ?? clearTimeout)(this.timer);
    this.timer = null;
    this.fired = true;
  }
}
