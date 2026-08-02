/**
 * BudgetTracker — the run-scoped resource accountant for agentic tool use
 * (FEAT-024 TASK-001, plan_agentic.md §9).
 *
 * Every budget the plan lists for the pre-browser phase is enforced here:
 * wall-clock time, total tool calls, per-tool calls, per-tool execution
 * timeout, agent-visible bytes per result, cumulative agent-visible bytes per
 * run, and browser navigations/hosts (consumed later by FEAT-025). Exhaustion
 * never throws — it returns a typed {@link BudgetDecision} that the middleware
 * surfaces as a stable `BUDGET_EXHAUSTED` tool result.
 *
 * **Terminal calls are exempt from the run-wide cumulative caps.** A budget
 * exists to bound *exploration*; the terminal publication tool is the run's
 * exit, not exploration. Charging it against the same pool the exploration
 * tools drain means a run that gathered everything it needed can be denied the
 * one call that turns that work into an artifact — observed in the field as
 * `result_publish` failing with "Total tool-call budget of 12 calls is
 * exhausted" after twelve successful searches and fetches, losing the whole
 * run. Terminal calls therefore skip the total-call and cumulative-byte caps
 * (both trivially small for a publication) while remaining bound by the
 * per-tool cap, which is what actually bounds a correction-retry loop.
 *
 * The tracker is intentionally a plain in-memory accountant with an injectable
 * clock so tests can assert exact boundary behaviour without real time passing.
 */

import type { Result } from '@yantra/protocol';
import { err, ok } from '@yantra/protocol';

/** Monotonic millisecond clock (injectable for deterministic tests). */
export type NowMs = () => number;

/** Which limit an exhausted budget hit. Stable strings — audited and rendered. */
export type BudgetLimit =
  | 'wall-clock'
  | 'total-calls'
  | 'per-tool-calls'
  | 'cumulative-bytes'
  | 'navigations'
  | 'hosts';

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
}

/** Configurable budget limits. All are hard caps; see plan §9 for defaults. */
export interface BudgetLimits {
  /**
   * Maximum wall-clock time for the whole run, in milliseconds.
   * `Number.POSITIVE_INFINITY` disables the wall-clock cap (the default): local
   * models are slow enough that a fixed default deadline aborts legitimate
   * runs, so time-bounding a run is an explicit user/config decision.
   */
  readonly wallClockMs: number;
  /** Maximum number of tool calls across all tools. */
  readonly totalToolCalls: number;
  /** Default maximum calls for a single tool (overridable per tool). */
  readonly perToolCalls: number;
  /** Per-tool overrides for {@link perToolCalls}, keyed by tool name. */
  readonly perToolCallOverrides?: Readonly<Record<string, number>>;
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
}

/**
 * Default pre-browser budgets. These are configuration, not prompt promises
 * (plan §9). Chosen to let a genuine multi-source research task finish while
 * bounding runaway loops and injection-driven exfiltration.
 */
export const DEFAULT_BUDGET_LIMITS: BudgetLimits = {
  wallClockMs: Number.POSITIVE_INFINITY,
  totalToolCalls: 60,
  perToolCalls: 25,
  perToolTimeoutMs: 45 * 1000,
  maxBytesPerResult: 24 * 1024,
  maxBytesPerRun: 512 * 1024,
  maxNavigations: 30,
  maxHosts: 20,
};

/** Per-call accounting options shared by reservation and byte accounting. */
export interface BudgetCallOptions {
  /**
   * True for the run's terminal publication call. Exempts it from the run-wide
   * cumulative caps (total calls, cumulative bytes) so a run can always convert
   * the work it already did into a published artifact. Consumption is still
   * recorded, and the per-tool cap still applies.
   */
  readonly terminal?: boolean;
}

/** A point-in-time snapshot of consumption, for audit/report rendering. */
export interface BudgetSnapshot {
  readonly elapsedMs: number;
  readonly totalCalls: number;
  readonly perToolCalls: Readonly<Record<string, number>>;
  readonly cumulativeBytes: number;
  readonly navigations: number;
  readonly hosts: number;
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

  /** Per-tool execution timeout (milliseconds). */
  public get perToolTimeoutMs(): number {
    return this.limits.perToolTimeoutMs;
  }

  /** Maximum agent-visible bytes allowed in a single result. */
  public get maxBytesPerResult(): number {
    return this.limits.maxBytesPerResult;
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

  /**
   * Reserve one tool call: checks wall-clock, cumulative bytes, total-call, and
   * per-tool-call limits, then increments the counters on success. Atomic —
   * either the call is fully reserved or nothing is consumed.
   *
   * @param tool The tool name being invoked.
   * @param options Set `terminal` for the run's publication call, which skips
   *   the run-wide cumulative caps (see the module header).
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
    if (!terminal && this.cumulativeBytes >= this.limits.maxBytesPerRun) {
      return err(
        this.decide(
          'cumulative-bytes',
          `Cumulative agent-visible byte budget of ${this.limits.maxBytesPerRun} bytes is exhausted.`,
        ),
      );
    }
    if (!terminal && this.totalCalls >= this.limits.totalToolCalls) {
      return err(
        this.decide(
          'total-calls',
          `Total tool-call budget of ${this.limits.totalToolCalls} calls is exhausted.`,
        ),
      );
    }
    const perToolLimit = this.limits.perToolCallOverrides?.[tool] ?? this.limits.perToolCalls;
    const used = this.perToolCounts.get(tool) ?? 0;
    if (used >= perToolLimit) {
      return err(
        this.decide(
          'per-tool-calls',
          `Per-tool call budget of ${perToolLimit} for "${tool}" is exhausted.`,
        ),
      );
    }

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
    };
  }

  private decide(limit: BudgetLimit, message: string): BudgetDecision {
    return { code: 'BUDGET_EXHAUSTED', limit, message };
  }
}
