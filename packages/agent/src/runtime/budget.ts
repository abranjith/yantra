/**
 * BudgetTracker — the run-scoped resource accountant for agentic tool use
 * (FEAT-024 TASK-001, plan_agentic.md §9).
 *
 * Every budget the plan lists for the pre-browser phase is enforced here:
 * wall-clock time, total tool calls, per-tool calls, per-tool execution
 * timeout, agent-visible bytes per result, cumulative agent-visible bytes per
 * run, and browser navigations/hosts (consumed later by FEAT-025). Exhaustion
 * never throws — it returns a typed {@link BudgetDecision} that the middleware
 * surfaces as a stable `BUDGET_EXHAUSTED` tool result and the orchestrator
 * (FEAT-026) maps to a run abort.
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
   * @returns `ok()` when the call fits every budget, else `err(decision)`.
   */
  public reserveCall(tool: string): Result<void, BudgetDecision> {
    if (this.isWallClockExhausted()) {
      return err(
        this.decide(
          'wall-clock',
          `Run wall-clock budget of ${this.limits.wallClockMs}ms is exhausted.`,
        ),
      );
    }
    if (this.cumulativeBytes >= this.limits.maxBytesPerRun) {
      return err(
        this.decide(
          'cumulative-bytes',
          `Cumulative agent-visible byte budget of ${this.limits.maxBytesPerRun} bytes is exhausted.`,
        ),
      );
    }
    if (this.totalCalls >= this.limits.totalToolCalls) {
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
   * @param bytes Byte length of the sanitized, bounded model-visible result.
   * @returns `ok()` if the run cap still holds, else `err(decision)`.
   */
  public accountResultBytes(bytes: number): Result<void, BudgetDecision> {
    this.cumulativeBytes += Math.max(0, bytes);
    if (this.cumulativeBytes > this.limits.maxBytesPerRun) {
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
