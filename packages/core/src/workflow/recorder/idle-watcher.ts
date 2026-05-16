/**
 * Idle watcher — emits an event when no actions are captured for a configurable period.
 *
 * Does NOT auto-stop the recording. On fire it emits `IdleTimeoutPromptEvent` and
 * lets the CLI (FEAT-012) prompt the user. The session keeps running until the user
 * responds. The CLI calls `session.stop('idle_timeout')` on confirmation.
 */

export const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export interface IdleWatcherCallbacks {
  /** Called when idle threshold is exceeded. Not called again until reset. */
  onIdleTimeout(): void;
}

/**
 * Resets on every `ping()` call; fires `onIdleTimeout()` after `timeoutMs`
 * of inactivity. Safe to call `stop()` multiple times.
 *
 * @example
 * const watcher = new IdleWatcher({ onIdleTimeout: () => promptUser() });
 * watcher.start(5_000);
 * // ... on each captured action:
 * watcher.ping();
 * // cleanup:
 * watcher.stop();
 */
export class IdleWatcher {
  private readonly callbacks: IdleWatcherCallbacks;
  private timeoutMs: number;
  private handle: ReturnType<typeof setTimeout> | null = null;
  private fired = false;

  constructor(callbacks: IdleWatcherCallbacks) {
    this.callbacks = callbacks;
    this.timeoutMs = DEFAULT_IDLE_TIMEOUT_MS;
  }

  /**
   * Start the idle timer with the given threshold.
   *
   * @param timeoutMs - Milliseconds of inactivity before `onIdleTimeout` fires.
   *   Defaults to `DEFAULT_IDLE_TIMEOUT_MS` (5 min).
   */
  start(timeoutMs: number = DEFAULT_IDLE_TIMEOUT_MS): void {
    this.timeoutMs = timeoutMs;
    this.schedule();
  }

  /**
   * Reset the timer. Call on every captured action.
   * If the timer previously fired, this re-arms it.
   */
  ping(): void {
    this.fired = false;
    this.schedule();
  }

  /**
   * Stop the idle timer permanently. Safe to call multiple times.
   */
  stop(): void {
    if (this.handle !== null) {
      clearTimeout(this.handle);
      this.handle = null;
    }
  }

  private schedule(): void {
    this.stop();
    const timer = setTimeout(() => {
      if (!this.fired) {
        this.fired = true;
        this.callbacks.onIdleTimeout();
      }
    }, this.timeoutMs);
    // Allow Node to exit if the timer is the only pending operation
    if (typeof timer.unref === 'function') timer.unref();
    this.handle = timer;
  }
}
