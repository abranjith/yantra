/**
 * BudgetTracker — the run-scoped resource accountant for agentic tool use
 * (FEAT-024 TASK-001, plan_agentic.md §9).
 *
 * The tracker enforces the measurable safety envelope around agentic tool use:
 * a two-phase wall clock, per-tool execution timeout, agent-visible bytes per
 * result and run, and browser navigations/hosts. Economic bounds live at the
 * provider-token layer; tool-call counts remain audit data rather than caps.
 * Exhaustion never throws — it returns a typed {@link BudgetDecision} that the
 * middleware surfaces as a stable `BUDGET_EXHAUSTED` tool result.
 *
 * **Terminal calls are exempt from the run-wide cumulative caps.** A budget
 * exists to bound *exploration*; the terminal publication tool is the run's
 * exit, not exploration. Charging it against the same pool the exploration
 * tools drain means a run that gathered everything it needed can be denied the
 * one call that turns that work into an artifact. Terminal calls therefore
 * skip the soft wall-clock wind-down and
 * cumulative-byte cap so a run can publish the evidence it already gathered.
 * The hard wall clock still binds every call.
 *
 * The tracker is intentionally a plain in-memory accountant with an injectable
 * clock so tests can assert exact boundary behaviour without real time passing.
 */

import type { Result } from '@yantra/protocol';
import { err, ok } from '@yantra/protocol';

import { renderAgentMessage } from './messages.js';

/**
 * Whether a refusal message already carries the publish instruction.
 *
 * Read from the message rather than tracked per limit, so a reworded decision
 * cannot silently reintroduce the duplicate.
 */
const PUBLISH_REMEDY_RE = /\bpublish\b/i;

/** Monotonic millisecond clock (injectable for deterministic tests). */
export type NowMs = () => number;

/** Which limit an exhausted budget hit. Stable strings — audited and rendered. */
export type BudgetLimit =
  | 'wall-clock'
  | 'wall-clock-soft'
  | 'stalled'
  | 'cumulative-bytes'
  | 'navigations'
  | 'hosts'
  | 'capture-count'
  | 'capture-pixels'
  | 'capture-bytes'
  | 'capture-mime'
  | 'deliverable-capture-count'
  | 'deliverable-capture-bytes'
  | 'deliverable-capture-pixels';

/**
 * A typed exhaustion decision. Carries the stable machine code shared by every
 * budget breach plus the specific limit that tripped for actionable messages.
 */
export interface BudgetDecision {
  /** Stable machine code (plan §9). */
  readonly code: 'BUDGET_EXHAUSTED';
  /** The specific limit that was exhausted. */
  readonly limit: BudgetLimit;
  /** Human-readable, secret-free explanation. */
  readonly message: string;
  /**
   * Whether {@link message} already tells the caller to publish what it has.
   *
   * The remedy belongs to the decision that knows whether one is present. It
   * used to be appended unconditionally one layer up, so a soft wall-clock
   * refusal — whose own message already says exactly that — carried the same
   * instruction twice and the agent read it twice.
   */
  readonly carriesPublishRemedy: boolean;
}

/** Configurable safety limits; the soft fraction starts publication wind-down. */
export interface BudgetLimits {
  /**
   * Maximum wall-clock time for the whole run, in milliseconds.
   * A custom `Number.POSITIVE_INFINITY` disables the cap; production agentic
   * runs use a finite default resolved by the shared option surface.
   */
  readonly wallClockMs: number;
  /** Fraction of the wall clock after which exploration winds down. */
  readonly softWallClockFraction: number;
  /** Maximum execution time for a single tool call, in milliseconds. */
  readonly perToolTimeoutMs: number;
  /** Maximum agent-visible bytes in a single tool result. */
  readonly maxBytesPerResult: number;
  /** Maximum cumulative agent-visible bytes across the whole run. */
  readonly maxBytesPerRun: number;
  /** Maximum browser navigations for the run (consumed by FEAT-025). */
  readonly maxNavigations: number;
  /** Maximum distinct outbound hosts for the run. */
  readonly maxHosts: number;
  /** Maximum screenshots accepted during one run. */
  readonly maxCaptures: number;
  /** Maximum pixels in one screenshot. */
  readonly maxCapturePixels: number;
  /** Maximum encoded bytes in one screenshot. */
  readonly maxCaptureBytes: number;
  /**
   * Deliverable capture (`browser_capture`, FEAT-058 S4) has its own budget,
   * separate from Vision Assist's: its pixels never reach the provider, and a
   * full page is taller than Vision's bound by design. Most calls per run.
   */
  readonly maxDeliverableCaptures: number;
  /** Most PNG files one deliverable capture call writes. */
  readonly maxDeliverablePartsPerCall: number;
  /** Widest deliverable tile, in pixels. */
  readonly maxDeliverableTileWidth: number;
  /** Tallest deliverable tile, in pixels. */
  readonly maxDeliverableTileHeight: number;
  /** Most bytes in one deliverable PNG. */
  readonly maxDeliverableFileBytes: number;
  /** Most deliverable bytes written across the run. */
  readonly maxDeliverableBytesPerRun: number;
}

/**
 * Default pre-browser budgets. These are configuration, not prompt promises
 * (plan §9). Chosen to let a genuine multi-source research task finish while
 * bounding runaway loops and injection-driven exfiltration.
 */
export const DEFAULT_BUDGET_LIMITS: BudgetLimits = {
  wallClockMs: 15 * 60 * 1000,
  softWallClockFraction: 0.8,
  perToolTimeoutMs: 45 * 1000,
  maxBytesPerResult: 24 * 1024,
  maxBytesPerRun: 512 * 1024,
  maxNavigations: 30,
  maxHosts: 20,
  maxCaptures: 3,
  maxCapturePixels: 1600 * 1200,
  maxCaptureBytes: 5 * 1024 * 1024,
  maxDeliverableCaptures: 4,
  maxDeliverablePartsPerCall: 6,
  maxDeliverableTileWidth: 1920,
  maxDeliverableTileHeight: 4096,
  maxDeliverableFileBytes: 8 * 1024 * 1024,
  maxDeliverableBytesPerRun: 40 * 1024 * 1024,
};

/** Per-call accounting options shared by reservation and byte accounting. */
export interface BudgetCallOptions {
  /**
   * True for the run's terminal publication call. Exempts it from the run-wide
   * cumulative caps (soft wall clock, cumulative bytes) so a run can always convert
   * the work it already did into a published artifact. Consumption is still
   * recorded, and per-result output bounding still applies.
   */
  readonly terminal?: boolean;
  /**
   * True for a call that must stay available during the exploration wind-down
   * (`task_contract`, FEAT-054 S1). It skips only the soft wall-clock refusal:
   * the hard wall clock, the cumulative-byte cap, and per-tool caps still bind.
   * Without it, a `CONTRACT_REQUIRED` refusal at wind-down would name a move
   * the engine then refuses.
   */
  readonly windDownExempt?: boolean;
}

/** A point-in-time snapshot of consumption, for audit/report rendering. */
export interface BudgetSnapshot {
  readonly elapsedMs: number;
  readonly totalCalls: number;
  readonly perToolCalls: Readonly<Record<string, number>>;
  readonly cumulativeBytes: number;
  readonly navigations: number;
  readonly hosts: number;
  readonly captureCount: number;
  readonly capturePixels: number;
  readonly captureBytes: number;
  /** Deliverable captures reserved (FEAT-058); never counted against Vision's. */
  readonly deliverableCaptureCount: number;
  /** Deliverable bytes accounted. */
  readonly deliverableCaptureBytes: number;
}

/** One deliverable PNG's measurements, checked before anything is written. */
export interface DeliverableFileMeasurement {
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
}

/** Measurements checked before image data may cross the provider seam. */
export interface CaptureMeasurement {
  readonly mimeType: unknown;
  readonly width: unknown;
  readonly height: unknown;
  readonly bytes: unknown;
}

/**
 * Run-scoped budget accountant. One instance per agentic run; all tool
 * middleware for that run shares it.
 *
 * @example
 * const budgets = new BudgetTracker(DEFAULT_BUDGET_LIMITS);
 * const reserved = budgets.reserveCall('web_search');
 * if (!reserved.isOk) return budgetExhaustedResult(reserved.error);
 */
export class BudgetTracker {
  private readonly startedAt: number;
  private readonly now: NowMs;
  private readonly perToolCounts = new Map<string, number>();
  private readonly seenHosts = new Set<string>();
  private totalCalls = 0;
  private cumulativeBytes = 0;
  private navigations = 0;
  private captureCount = 0;
  private capturePixels = 0;
  private captureBytes = 0;
  private deliverableCaptureCount = 0;
  private deliverableCaptureBytes = 0;
  private softWindDown = false;
  private frozen = false;
  private frozenRefusals = 0;

  /**
   * @param limits Hard caps for this run.
   * @param now Injectable millisecond clock (defaults to `Date.now`).
   */
  public constructor(
    private readonly limits: BudgetLimits,
    now: NowMs = () => Date.now(),
  ) {
    this.now = now;
    this.startedAt = now();
  }

  /** Time reserved for exploration; null means unbounded. */
  public explorationRemainingMs(): number | null {
    return Number.isFinite(this.limits.wallClockMs)
      ? Math.max(
          0,
          this.limits.wallClockMs * this.limits.softWallClockFraction -
            (this.now() - this.startedAt),
        )
      : null;
  }
  /** Fixed publication headroom, independent of elapsed time. */
  public publicationHeadroomMs(): number | null {
    return Number.isFinite(this.limits.wallClockMs)
      ? Math.round(this.limits.wallClockMs * (1 - this.limits.softWallClockFraction))
      : null;
  }
  public freezeExploration(): void {
    this.frozen = true;
  }
  /** Restore ordinary budgets if the advisory progress subsystem fails open. */
  public clearProgressFreeze(): void {
    this.frozen = false;
  }
  public isFrozen(): boolean {
    return this.frozen;
  }
  public refusedAfterFreeze(): number {
    return this.frozenRefusals;
  }

  /** Per-tool execution timeout (milliseconds). */
  /**
   * The navigation and distinct-host ceilings, for the budget meter every
   * evidence result carries (FEAT-050). A read-only view: callers never
   * reach into the tracker's private limits.
   */
  public limitsView(): { readonly maxNavigations: number; readonly maxHosts: number } {
    return { maxNavigations: this.limits.maxNavigations, maxHosts: this.limits.maxHosts };
  }

  public get perToolTimeoutMs(): number {
    return this.limits.perToolTimeoutMs;
  }

  /** Maximum agent-visible bytes allowed in a single result. */
  public get maxBytesPerResult(): number {
    return this.limits.maxBytesPerResult;
  }

  public get maxCapturePixels(): number {
    return this.limits.maxCapturePixels;
  }

  public get maxCaptureBytes(): number {
    return this.limits.maxCaptureBytes;
  }

  public remainingCaptures(): number {
    return Math.max(0, this.limits.maxCaptures - this.captureCount);
  }

  /** Atomically reserves one capture ordinal against its dedicated counter. */
  public reserveCapture(): Result<void, BudgetDecision> {
    if (this.captureCount >= this.limits.maxCaptures) {
      return err(
        this.decide(
          'capture-count',
          `Capture count budget of ${this.limits.maxCaptures} screenshots is exhausted.`,
        ),
      );
    }
    this.captureCount += 1;
    return ok(undefined);
  }

  /** Validates and accounts encoded image measurements without touching text counters. */
  public accountCaptureBytes(measurement: CaptureMeasurement): Result<void, BudgetDecision> {
    if (measurement.mimeType !== 'image/png') {
      return err(this.decide('capture-mime', 'Capture encoding must be image/png.'));
    }
    if (
      !validNonnegativeInteger(measurement.width) ||
      !validNonnegativeInteger(measurement.height)
    ) {
      return err(this.decide('capture-pixels', 'Capture dimensions are missing or invalid.'));
    }
    if (measurement.width === 0 || measurement.height === 0) {
      return err(this.decide('capture-pixels', 'Capture dimensions must be positive.'));
    }
    const pixels = measurement.width * measurement.height;
    if (
      measurement.width > 1600 ||
      measurement.height > 1200 ||
      !Number.isSafeInteger(pixels) ||
      pixels > this.limits.maxCapturePixels
    ) {
      return err(
        this.decide(
          'capture-pixels',
          `Capture pixel budget of ${this.limits.maxCapturePixels} pixels was exceeded.`,
        ),
      );
    }
    if (!validNonnegativeInteger(measurement.bytes)) {
      return err(this.decide('capture-bytes', 'Capture byte count is missing or invalid.'));
    }
    if (measurement.bytes > this.limits.maxCaptureBytes) {
      return err(
        this.decide(
          'capture-bytes',
          `Capture byte budget of ${this.limits.maxCaptureBytes} bytes was exceeded.`,
        ),
      );
    }
    this.capturePixels += pixels;
    this.captureBytes += measurement.bytes;
    return ok(undefined);
  }

  /** The pixel and part bounds one deliverable capture call obeys. */
  public deliverableBounds(): {
    readonly tileWidth: number;
    readonly tileHeight: number;
    readonly maxParts: number;
  } {
    return {
      tileWidth: this.limits.maxDeliverableTileWidth,
      tileHeight: this.limits.maxDeliverableTileHeight,
      maxParts: this.limits.maxDeliverablePartsPerCall,
    };
  }

  /** Deliverable captures the run may still take. */
  public remainingDeliverableCaptures(): number {
    return Math.max(0, this.limits.maxDeliverableCaptures - this.deliverableCaptureCount);
  }

  /**
   * Reserves one deliverable capture against its own counter, never Vision's.
   * The returned ordinal names the call's files (`capture-<seq>-…`).
   */
  public reserveDeliverableCapture(): Result<number, BudgetDecision> {
    if (this.deliverableCaptureCount >= this.limits.maxDeliverableCaptures) {
      return err(
        this.decide(
          'deliverable-capture-count',
          `The saved-screenshot budget of ${this.limits.maxDeliverableCaptures} captures for ` +
            'this run is spent. Publish with the captures already saved.',
        ),
      );
    }
    this.deliverableCaptureCount += 1;
    return ok(this.deliverableCaptureCount);
  }

  /**
   * Validates every file of one deliverable capture call — the part count,
   * each file's pixels and bytes, and the run total — and accounts the bytes
   * only when all of them fit. Called before anything is written, so a
   * refused call writes nothing.
   */
  public accountDeliverableBytes(
    files: readonly DeliverableFileMeasurement[],
  ): Result<void, BudgetDecision> {
    if (files.length === 0 || files.length > this.limits.maxDeliverablePartsPerCall) {
      return err(
        this.decide(
          'deliverable-capture-pixels',
          `A saved capture holds 1 to ${this.limits.maxDeliverablePartsPerCall} files; this one had ${files.length}.`,
        ),
      );
    }
    let total = 0;
    for (const file of files) {
      if (
        !validNonnegativeInteger(file.width) ||
        !validNonnegativeInteger(file.height) ||
        file.width === 0 ||
        file.height === 0 ||
        file.width > this.limits.maxDeliverableTileWidth ||
        file.height > this.limits.maxDeliverableTileHeight
      ) {
        return err(
          this.decide(
            'deliverable-capture-pixels',
            `A saved capture file exceeded the ${this.limits.maxDeliverableTileWidth} by ` +
              `${this.limits.maxDeliverableTileHeight} pixel limit.`,
          ),
        );
      }
      if (
        !validNonnegativeInteger(file.bytes) ||
        file.bytes > this.limits.maxDeliverableFileBytes
      ) {
        return err(
          this.decide(
            'deliverable-capture-bytes',
            `A saved capture file exceeded the ${this.limits.maxDeliverableFileBytes} byte limit.`,
          ),
        );
      }
      total += file.bytes;
    }
    if (this.deliverableCaptureBytes + total > this.limits.maxDeliverableBytesPerRun) {
      return err(
        this.decide(
          'deliverable-capture-bytes',
          `Saved captures would exceed the run's ${this.limits.maxDeliverableBytesPerRun} byte ` +
            'limit. Publish with the captures already saved.',
        ),
      );
    }
    this.deliverableCaptureBytes += total;
    return ok(undefined);
  }

  /**
   * Milliseconds remaining on the wall-clock budget (never negative).
   * Returns `Number.POSITIVE_INFINITY` when the run is not time-bounded.
   */
  public remainingWallClockMs(): number {
    return Math.max(0, this.limits.wallClockMs - (this.now() - this.startedAt));
  }

  /** True once the wall-clock budget is spent. */
  public isWallClockExhausted(): boolean {
    return this.now() - this.startedAt >= this.limits.wallClockMs;
  }

  /** True once the exploration wind-down boundary is reached. */
  public isSoftWallClockExhausted(): boolean {
    return (
      this.now() - this.startedAt >= this.limits.wallClockMs * this.limits.softWallClockFraction
    );
  }

  /**
   * True once any call was reserved or refused past the soft wall-clock
   * boundary: the run entered its exploration wind-down. The orchestrator
   * reads it to record a `wall-clock-soft` termination reason.
   */
  public get softWindDownReached(): boolean {
    return this.softWindDown;
  }

  /**
   * Reserve one tool call: checks the hard/soft wall clocks and cumulative
   * bytes, then increments the audit counters on success. Atomic —
   * either the call is fully reserved or nothing is consumed.
   *
   * @param tool The tool name being invoked.
   * @param options Set `terminal` for the run's publication call, which skips
   *   the run-wide cumulative caps (see the module header); set
   *   `windDownExempt` to skip only the soft wall-clock refusal.
   * @returns `ok()` when the call fits every budget, else `err(decision)`.
   */
  public reserveCall(tool: string, options: BudgetCallOptions = {}): Result<void, BudgetDecision> {
    // The wall clock binds every call, terminal included: an out-of-time run is
    // over regardless, and the orchestrator's own timer has already fired.
    if (this.isWallClockExhausted()) {
      return err(
        this.decide(
          'wall-clock',
          `Run wall-clock budget of ${this.limits.wallClockMs}ms is exhausted.`,
        ),
      );
    }
    const terminal = options.terminal === true;
    if (this.frozen && !terminal && options.windDownExempt !== true) {
      this.frozenRefusals += 1;
      return err(
        this.decide('stalled', renderAgentMessage('middleware', 'BUDGET_EXHAUSTED', 'stalled')),
      );
    }
    const pastSoftBoundary = this.isSoftWallClockExhausted();
    if (pastSoftBoundary) this.softWindDown = true;
    if (!terminal && options.windDownExempt !== true && pastSoftBoundary) {
      return err(
        this.decide(
          'wall-clock-soft',
          'The run is out of exploration time. Publish now using the evidence already gathered.',
        ),
      );
    }
    if (!terminal && this.cumulativeBytes >= this.limits.maxBytesPerRun) {
      return err(
        this.decide(
          'cumulative-bytes',
          `Cumulative agent-visible byte budget of ${this.limits.maxBytesPerRun} bytes is exhausted.`,
        ),
      );
    }
    const used = this.perToolCounts.get(tool) ?? 0;

    this.totalCalls += 1;
    this.perToolCounts.set(tool, used + 1);
    return ok(undefined);
  }

  /**
   * Account agent-visible bytes produced by a completed result and check the
   * cumulative run cap. The middleware bounds a single result to
   * {@link maxBytesPerResult} *before* calling this, so a single call cannot
   * exceed the per-result cap; this guards the run-wide total.
   *
   * A terminal call's bytes are recorded but never rejected: the publication
   * already happened by the time its result is measured, so failing here would
   * report a successful publish as an error and strand the artifact.
   *
   * @param bytes Byte length of the sanitized, bounded model-visible result.
   * @param options Set `terminal` for the run's publication call.
   * @returns `ok()` if the run cap still holds, else `err(decision)`.
   */
  public accountResultBytes(
    bytes: number,
    options: BudgetCallOptions = {},
  ): Result<void, BudgetDecision> {
    this.cumulativeBytes += Math.max(0, bytes);
    if (options.terminal !== true && this.cumulativeBytes > this.limits.maxBytesPerRun) {
      return err(
        this.decide(
          'cumulative-bytes',
          `Cumulative agent-visible byte budget of ${this.limits.maxBytesPerRun} bytes is exhausted.`,
        ),
      );
    }
    return ok(undefined);
  }

  /**
   * Reserve one browser navigation to a host: checks the navigation cap and the
   * distinct-host cap, counting the host against the run's host budget the first
   * time it is seen. Consumed by FEAT-025's browser tools and by the outbound
   * URL policy's new-host decrement (plan §8.13).
   *
   * @param host Lowercased hostname being navigated/fetched.
   * @returns `ok()` when both caps hold, else `err(decision)`.
   */
  public reserveNavigation(host: string): Result<void, BudgetDecision> {
    if (this.navigations >= this.limits.maxNavigations) {
      return err(
        this.decide(
          'navigations',
          `Navigation budget of ${this.limits.maxNavigations} navigations is exhausted.`,
        ),
      );
    }
    const isNewHost = !this.seenHosts.has(host);
    if (isNewHost && this.seenHosts.size >= this.limits.maxHosts) {
      return err(
        this.decide('hosts', `Distinct-host budget of ${this.limits.maxHosts} hosts is exhausted.`),
      );
    }
    this.navigations += 1;
    this.seenHosts.add(host);
    return ok(undefined);
  }

  /** Immutable snapshot of current consumption for audit/report rendering. */
  public snapshot(): BudgetSnapshot {
    return {
      elapsedMs: this.now() - this.startedAt,
      totalCalls: this.totalCalls,
      perToolCalls: Object.fromEntries(this.perToolCounts),
      cumulativeBytes: this.cumulativeBytes,
      navigations: this.navigations,
      hosts: this.seenHosts.size,
      captureCount: this.captureCount,
      capturePixels: this.capturePixels,
      captureBytes: this.captureBytes,
      deliverableCaptureCount: this.deliverableCaptureCount,
      deliverableCaptureBytes: this.deliverableCaptureBytes,
    };
  }

  private decide(limit: BudgetLimit, message: string): BudgetDecision {
    return {
      code: 'BUDGET_EXHAUSTED',
      limit,
      message,
      carriesPublishRemedy: limit === 'stalled' || PUBLISH_REMEDY_RE.test(message),
    };
  }
}

function validNonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
