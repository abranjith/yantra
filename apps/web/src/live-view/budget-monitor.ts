/**
 * The live view's performance budget (FEAT-069 TASK-011, plan §10/§14).
 *
 * A pure monitor over fixed 5-second windows with an injected clock. The
 * live-view store feeds it every frame offered and drawn and the main-thread
 * time its handlers took; the cockpit may add long-animation-frame time that
 * belongs to message handling. A window is **over budget** when the worker
 * offered at least {@link BUDGET_MIN_FPS} frames per second and the window
 * either drew fewer than that or spent more than {@link BUDGET_MAX_SHARE} of
 * one core on live-view work. Two such windows in a row report
 * `over_budget`, once; the cockpit then switches itself to Solid.
 *
 * Thresholds come from spike S1 (`spike-s1-report.md`): the plan §10 values
 * stand, because measured headroom was wide.
 */

/** Window length, ms. */
export const BUDGET_WINDOW_MS = 5_000;
/** Frames per second the live view must hold (§14). */
export const BUDGET_MIN_FPS = 5;
/** Largest share of one core live-view work may take (§10). */
export const BUDGET_MAX_SHARE = 0.15;
/** Consecutive over-budget windows before switching. */
export const BUDGET_WINDOWS_TO_SWITCH = 2;

/** What one closed window measured. */
export interface BudgetWindow {
  readonly offeredFps: number;
  readonly drawnFps: number;
  /** Live-view main-thread time over wall time. */
  readonly share: number;
  readonly overBudget: boolean;
}

export type BudgetVerdict = 'ok' | 'over_budget';

export interface BudgetMonitorOptions {
  /** Monotonic ms (default `performance.now`). */
  readonly now?: () => number;
  /** Called once, when the budget is first exceeded for long enough. */
  readonly onOverBudget?: () => void;
  /** When true (a Solid preference, reduced transparency), the monitor never acts. */
  readonly disabled?: boolean;
}

export class BudgetMonitor {
  private readonly now: () => number;
  private windowStart: number;
  private offered = 0;
  private drawn = 0;
  private busyMs = 0;
  private streak = 0;
  private verdictValue: BudgetVerdict = 'ok';
  /** Closed windows, newest last (for tests and diagnostics; bounded). */
  public readonly windows: BudgetWindow[] = [];

  public constructor(private readonly options: BudgetMonitorOptions = {}) {
    this.now = options.now ?? (() => performance.now());
    this.windowStart = this.now();
  }

  public get verdict(): BudgetVerdict {
    return this.verdictValue;
  }

  /** A frame arrived from the host. */
  public frameOffered(busyMs = 0): void {
    this.roll();
    this.offered += 1;
    this.busyMs += Math.max(0, busyMs);
  }

  /** A frame reached the canvas. */
  public frameDrawn(busyMs = 0): void {
    this.roll();
    this.drawn += 1;
    this.busyMs += Math.max(0, busyMs);
  }

  /** Other main-thread time spent on live-view work (long animation frames). */
  public addBusy(ms: number): void {
    this.roll();
    this.busyMs += Math.max(0, ms);
  }

  /** Closes any windows that have ended; call periodically so quiet time counts too. */
  public tick(): void {
    this.roll();
  }

  private roll(): void {
    const now = this.now();
    while (now - this.windowStart >= BUDGET_WINDOW_MS) {
      this.close();
      this.windowStart += BUDGET_WINDOW_MS;
    }
  }

  private close(): void {
    const seconds = BUDGET_WINDOW_MS / 1000;
    const offeredFps = this.offered / seconds;
    const drawnFps = this.drawn / seconds;
    const share = this.busyMs / BUDGET_WINDOW_MS;
    const overBudget =
      offeredFps >= BUDGET_MIN_FPS && (drawnFps < BUDGET_MIN_FPS || share > BUDGET_MAX_SHARE);
    this.windows.push({ offeredFps, drawnFps, share, overBudget });
    if (this.windows.length > 12) this.windows.shift();
    this.offered = 0;
    this.drawn = 0;
    this.busyMs = 0;
    this.streak = overBudget ? this.streak + 1 : 0;
    if (
      this.streak >= BUDGET_WINDOWS_TO_SWITCH &&
      this.verdictValue === 'ok' &&
      this.options.disabled !== true
    ) {
      this.verdictValue = 'over_budget';
      this.options.onOverBudget?.();
    }
  }
}

/**
 * The live view already runs Solid (the preference, or the OS asks for less
 * transparency), so there is nothing to switch.
 */
export function solidAlready(
  root: HTMLElement,
  matchMedia?: (query: string) => MediaQueryList,
): boolean {
  if (root.dataset.surfaces === 'solid') return true;
  return matchMedia?.('(prefers-reduced-transparency: reduce)').matches === true;
}
