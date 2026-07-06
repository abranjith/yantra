import { describe, expect, it } from 'vitest';

import { BudgetTracker } from '../../src/research/budget.js';
import type { ResearchBudget } from '../../src/research/types.js';

const budget: ResearchBudget = {
  maxHops: 2,
  maxSources: 5,
  maxWallClockMs: 1_000,
  maxLlmCalls: 3,
};

/** A controllable fake clock so wall-clock tests never sleep. */
function fakeClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
}

describe('@no-llm research/budget', () => {
  it('reports budget remaining while every dimension is untouched', () => {
    const tracker = new BudgetTracker(budget, { now: fakeClock().now });

    const checkpoint = tracker.checkpoint();

    expect(checkpoint.isOk).toBe(true);
    expect(tracker.canStartHop()).toBe(true);
    expect(tracker.remainingSources()).toBe(5);
  });

  it('stops on the wall-clock dimension without any real sleep', () => {
    const clock = fakeClock();
    const tracker = new BudgetTracker(budget, { now: clock.now });

    clock.advance(1_000);
    const checkpoint = tracker.checkpoint();

    expect(checkpoint.isOk).toBe(false);
    if (!checkpoint.isOk) {
      expect(checkpoint.error.dimension).toBe('wall_clock');
    }
  });

  it('stops on the source dimension once the source cap is reached', () => {
    const tracker = new BudgetTracker(budget, { now: fakeClock().now });

    tracker.recordSources(5);

    expect(tracker.sourcesExhausted()).toBe(true);
    expect(tracker.remainingSources()).toBe(0);
    const checkpoint = tracker.checkpoint();
    expect(checkpoint.isOk).toBe(false);
    if (!checkpoint.isOk) {
      expect(checkpoint.error.dimension).toBe('max_sources');
    }
  });

  it('stops on the LLM dimension once the call cap is reached', () => {
    const tracker = new BudgetTracker(budget, { now: fakeClock().now });

    tracker.recordLlmCall();
    tracker.recordLlmCall();
    tracker.recordLlmCall();

    expect(tracker.llmCallsExhausted()).toBe(true);
    const checkpoint = tracker.checkpoint();
    expect(checkpoint.isOk).toBe(false);
    if (!checkpoint.isOk) {
      expect(checkpoint.error.dimension).toBe('max_llm_calls');
    }
  });

  it('gates hops via canStartHop, not the recurring work checkpoint', () => {
    const tracker = new BudgetTracker(budget, { now: fakeClock().now });

    tracker.recordHop();
    tracker.recordHop();

    // Hop budget is a loop-level gate — an in-progress hop must still be able
    // to finish fetching, so checkpoint() stays ok while only hops are used.
    expect(tracker.canStartHop()).toBe(false);
    expect(tracker.checkpoint().isOk).toBe(true);
  });

  it('prioritizes wall-clock over other exhausted dimensions', () => {
    const clock = fakeClock();
    const tracker = new BudgetTracker(budget, { now: clock.now });

    tracker.recordSources(5);
    tracker.recordLlmCall();
    tracker.recordLlmCall();
    tracker.recordLlmCall();
    clock.advance(2_000);

    const checkpoint = tracker.checkpoint();
    expect(checkpoint.isOk).toBe(false);
    if (!checkpoint.isOk) {
      expect(checkpoint.error.dimension).toBe('wall_clock');
    }
  });

  it('exposes a monotonic snapshot of remaining budget', () => {
    const clock = fakeClock();
    const tracker = new BudgetTracker(budget, { now: clock.now });

    tracker.recordHop();
    tracker.recordSources(2);
    tracker.recordLlmCall();
    clock.advance(400);

    const snapshot = tracker.snapshot();
    expect(snapshot).toMatchObject({
      hopsUsed: 1,
      hopsRemaining: 1,
      sourcesUsed: 2,
      sourcesRemaining: 3,
      llmCallsUsed: 1,
      llmCallsRemaining: 2,
      elapsedMs: 400,
      wallClockRemainingMs: 600,
    });
  });
});
