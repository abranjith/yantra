/**
 * BudgetTracker — the single enforcement point for all four research budgets
 * (hops, sources, wall-clock, LLM calls).
 *
 * The controller consumes budget as it works (`recordHop`, `recordSources`,
 * `recordLlmCall`) and calls {@link BudgetTracker.checkpoint} at the loop's
 * decision points — including mid-fetch — to stop cleanly the instant any cap
 * is hit. The clock is injectable so tests prove wall-clock termination with a
 * fake clock and **zero real sleeps** (mirrors the executor's injectable
 * `Clock`, memory §Architecture: DI, no hard-to-test singletons).
 */

import type { Result } from '@yantra/protocol';
import { err, ok } from '@yantra/protocol';

import type { BudgetDimension, BudgetExhausted, BudgetSnapshot, ResearchBudget } from './types.js';

/** Injectable dependencies (a monotonic-ish clock for wall-clock checks). */
export interface BudgetTrackerDeps {
  /** Returns "now" in epoch milliseconds; defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * Tracks and enforces the {@link ResearchBudget}. All consumption is monotonic
 * (counters only increase); `checkpoint()` reports the first exhausted
 * dimension in the plan's priority order.
 */
export class BudgetTracker {
  private readonly budget: ResearchBudget;
  private readonly now: () => number;
  private readonly startedAtMs: number;

  private hopsUsed = 0;
  private sourcesUsed = 0;
  private llmCallsUsed = 0;

  /**
   * @param budget - The caps to enforce.
   * @param deps - Injectable clock (defaults to wall-clock `Date.now`).
   */
  public constructor(budget: ResearchBudget, deps: BudgetTrackerDeps = {}) {
    this.budget = budget;
    this.now = deps.now ?? Date.now;
    this.startedAtMs = this.now();
  }

  /** Records that a hop has started (counts toward `maxHops`). */
  public recordHop(): void {
    this.hopsUsed += 1;
  }

  /** Records `count` sources kept (counts toward `maxSources`). */
  public recordSources(count: number): void {
    this.sourcesUsed += Math.max(0, count);
  }

  /** Records one LLM call (counts toward `maxLlmCalls`). */
  public recordLlmCall(): void {
    this.llmCallsUsed += 1;
  }

  /** True while another hop may start (`hopsUsed < maxHops`). */
  public canStartHop(): boolean {
    return this.hopsUsed < this.budget.maxHops;
  }

  /** Sources that may still be kept before the pool cap is reached. */
  public remainingSources(): number {
    return Math.max(0, this.budget.maxSources - this.sourcesUsed);
  }

  /** True once the source cap is reached. */
  public sourcesExhausted(): boolean {
    return this.sourcesUsed >= this.budget.maxSources;
  }

  /** True once the LLM-call cap is reached (callers fall back to deterministic). */
  public llmCallsExhausted(): boolean {
    return this.llmCallsUsed >= this.budget.maxLlmCalls;
  }

  /** Elapsed wall-clock time in milliseconds since construction. */
  public elapsedMs(): number {
    return Math.max(0, this.now() - this.startedAtMs);
  }

  /**
   * Checks the *recurring work* budgets — wall-clock, sources, and LLM calls —
   * in priority order, returning `err(BudgetExhausted)` for the first exhausted
   * one. Used both at the top of the loop and before each source fetch, so it
   * deliberately excludes the hop budget (a loop-level gate; see
   * {@link canStartHop}) — a hop already in progress must be allowed to finish
   * fetching. Never throws.
   *
   * @returns `ok()` while work budget remains, else `err(BudgetExhausted)`.
   */
  public checkpoint(): Result<void, BudgetExhausted> {
    if (this.elapsedMs() >= this.budget.maxWallClockMs) {
      return err(this.exhausted('wall_clock', 'wall-clock budget exhausted'));
    }
    if (this.sourcesExhausted()) {
      return err(this.exhausted('max_sources', 'source budget exhausted'));
    }
    if (this.llmCallsExhausted()) {
      return err(this.exhausted('max_llm_calls', 'LLM-call budget exhausted'));
    }
    return ok(undefined);
  }

  /** A snapshot of remaining budget for the persisted ResearchState. */
  public snapshot(): BudgetSnapshot {
    const elapsedMs = this.elapsedMs();
    return {
      hopsUsed: this.hopsUsed,
      hopsRemaining: Math.max(0, this.budget.maxHops - this.hopsUsed),
      sourcesUsed: this.sourcesUsed,
      sourcesRemaining: this.remainingSources(),
      llmCallsUsed: this.llmCallsUsed,
      llmCallsRemaining: Math.max(0, this.budget.maxLlmCalls - this.llmCallsUsed),
      elapsedMs,
      wallClockRemainingMs: Math.max(0, this.budget.maxWallClockMs - elapsedMs),
    };
  }

  private exhausted(dimension: BudgetDimension, message: string): BudgetExhausted {
    return { dimension, message };
  }
}
