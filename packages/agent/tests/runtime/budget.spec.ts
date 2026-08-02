import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  BudgetTracker,
  DEFAULT_BUDGET_LIMITS,
  type BudgetLimits,
} from '../../src/runtime/budget.js';

/** A mutable clock so tests can advance wall-clock time deterministically. */
function fakeClock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return { now: () => current, advance: (ms) => (current += ms) };
}

const TIGHT_LIMITS: BudgetLimits = {
  wallClockMs: 1_000,
  totalToolCalls: 3,
  perToolCalls: 2,
  perToolTimeoutMs: 500,
  maxBytesPerResult: 100,
  maxBytesPerRun: 250,
  maxNavigations: 2,
  maxHosts: 2,
};

describe('@no-llm BudgetTracker call reservation', () => {
  it('reserves calls up to the per-tool limit and denies the one-over call', () => {
    const budgets = new BudgetTracker(TIGHT_LIMITS);

    expect(budgets.reserveCall('web_search').isOk).toBe(true);
    expect(budgets.reserveCall('web_search').isOk).toBe(true);

    const over = budgets.reserveCall('web_search');
    expect(over.isOk).toBe(false);
    if (!over.isOk) {
      expect(over.error.code).toBe('BUDGET_EXHAUSTED');
      expect(over.error.limit).toBe('per-tool-calls');
    }
  });

  it('denies once the total-call budget is spent even across different tools', () => {
    const budgets = new BudgetTracker({ ...TIGHT_LIMITS, perToolCalls: 10 });

    expect(budgets.reserveCall('a').isOk).toBe(true);
    expect(budgets.reserveCall('b').isOk).toBe(true);
    expect(budgets.reserveCall('c').isOk).toBe(true);

    const over = budgets.reserveCall('d');
    expect(over.isOk).toBe(false);
    if (!over.isOk) expect(over.error.limit).toBe('total-calls');
  });

  it('does not consume any budget when a reservation is denied', () => {
    const budgets = new BudgetTracker({ ...TIGHT_LIMITS, perToolCalls: 1 });
    expect(budgets.reserveCall('web_search').isOk).toBe(true);
    expect(budgets.reserveCall('web_search').isOk).toBe(false);
    // A different tool still has its own budget — the denied call left counters intact.
    expect(budgets.reserveCall('web_fetch').isOk).toBe(true);
    expect(budgets.snapshot().totalCalls).toBe(2);
  });

  it('honors per-tool overrides above the default per-tool cap', () => {
    const budgets = new BudgetTracker({
      ...TIGHT_LIMITS,
      totalToolCalls: 10,
      perToolCalls: 1,
      perToolCallOverrides: { result_publish: 3 },
    });
    expect(budgets.reserveCall('result_publish').isOk).toBe(true);
    expect(budgets.reserveCall('result_publish').isOk).toBe(true);
    expect(budgets.reserveCall('result_publish').isOk).toBe(true);
    expect(budgets.reserveCall('result_publish').isOk).toBe(false);
  });
});

describe('@no-llm BudgetTracker terminal-call exemption', () => {
  // Regression (run 20260801T222532Z-research-b99efc18): an agentic research run
  // spent all 12 of its total tool calls on 2 web_search + 10 web_fetch calls,
  // every one successful. The 13th call was `result_publish` — the ONLY way to
  // complete a run — and it was denied with "Total tool-call budget of 12 calls
  // is exhausted". The run finalized as budget_exhausted and every fetched
  // source was discarded, with the tool result reading as though publishing
  // itself were too expensive.
  it('grants the terminal call after the total-call budget is spent', () => {
    const budgets = new BudgetTracker({ ...TIGHT_LIMITS, perToolCalls: 10 });
    expect(budgets.reserveCall('web_search').isOk).toBe(true);
    expect(budgets.reserveCall('web_fetch').isOk).toBe(true);
    expect(budgets.reserveCall('web_fetch').isOk).toBe(true);
    // Exploration is now closed...
    const explore = budgets.reserveCall('web_fetch');
    expect(explore.isOk).toBe(false);
    if (!explore.isOk) expect(explore.error.limit).toBe('total-calls');

    // ...but the exit is not.
    expect(budgets.reserveCall('result_publish', { terminal: true }).isOk).toBe(true);
    expect(budgets.snapshot().totalCalls).toBe(4);
  });

  it('grants the terminal call after the cumulative byte budget is spent', () => {
    const budgets = new BudgetTracker(TIGHT_LIMITS);
    budgets.accountResultBytes(300); // over the 250 cap

    expect(budgets.reserveCall('web_fetch').isOk).toBe(false);
    expect(budgets.reserveCall('result_publish', { terminal: true }).isOk).toBe(true);
  });

  it('still binds the terminal call to its per-tool cap', () => {
    // The exemption must not turn an invalid-payload correction loop into an
    // unbounded one: per-tool calls remain the loop's ceiling.
    const budgets = new BudgetTracker({ ...TIGHT_LIMITS, totalToolCalls: 1, perToolCalls: 2 });
    expect(budgets.reserveCall('result_publish', { terminal: true }).isOk).toBe(true);
    expect(budgets.reserveCall('result_publish', { terminal: true }).isOk).toBe(true);

    const over = budgets.reserveCall('result_publish', { terminal: true });
    expect(over.isOk).toBe(false);
    if (!over.isOk) expect(over.error.limit).toBe('per-tool-calls');
  });

  it('still binds the terminal call to the wall clock', () => {
    // An out-of-time run is genuinely over; the exemption covers only the
    // cumulative caps a run can legitimately have spent on useful work.
    const clock = fakeClock();
    const budgets = new BudgetTracker(TIGHT_LIMITS, clock.now);
    clock.advance(1_000);

    const denied = budgets.reserveCall('result_publish', { terminal: true });
    expect(denied.isOk).toBe(false);
    if (!denied.isOk) expect(denied.error.limit).toBe('wall-clock');
  });

  it('records but never rejects the terminal call result bytes', () => {
    // The publication already happened by the time its bytes are measured, so
    // failing here would report a successful publish as an error.
    const budgets = new BudgetTracker(TIGHT_LIMITS);
    budgets.accountResultBytes(200);

    expect(budgets.accountResultBytes(100, { terminal: true }).isOk).toBe(true);
    expect(budgets.snapshot().cumulativeBytes).toBe(300);
  });

  it('leaves non-terminal calls fully bound by every cap', () => {
    const budgets = new BudgetTracker({ ...TIGHT_LIMITS, perToolCalls: 10 });
    budgets.reserveCall('a');
    budgets.reserveCall('b');
    budgets.reserveCall('c');

    // An explicit `terminal: false` is not a loophole either.
    expect(budgets.reserveCall('d', { terminal: false }).isOk).toBe(false);
    expect(budgets.reserveCall('d').isOk).toBe(false);
  });
});

describe('@no-llm BudgetTracker wall-clock', () => {
  it('is unlimited by default: no elapsed time exhausts the default wall clock', () => {
    const clock = fakeClock();
    const budgets = new BudgetTracker(DEFAULT_BUDGET_LIMITS, clock.now);

    expect(DEFAULT_BUDGET_LIMITS.wallClockMs).toBe(Number.POSITIVE_INFINITY);
    clock.advance(365 * 24 * 60 * 60 * 1000); // one simulated year
    expect(budgets.isWallClockExhausted()).toBe(false);
    expect(budgets.remainingWallClockMs()).toBe(Number.POSITIVE_INFINITY);
    expect(budgets.reserveCall('web_search').isOk).toBe(true);
  });

  it('passes exactly at the limit boundary and fails one millisecond over', () => {
    const clock = fakeClock();
    const budgets = new BudgetTracker(TIGHT_LIMITS, clock.now);

    clock.advance(999);
    expect(budgets.isWallClockExhausted()).toBe(false);
    expect(budgets.reserveCall('web_search').isOk).toBe(true);

    clock.advance(1); // now exactly at 1000ms — the limit
    expect(budgets.isWallClockExhausted()).toBe(true);
    const denied = budgets.reserveCall('web_search');
    expect(denied.isOk).toBe(false);
    if (!denied.isOk) expect(denied.error.limit).toBe('wall-clock');
  });

  it('reports remaining wall-clock time, clamped at zero', () => {
    const clock = fakeClock();
    const budgets = new BudgetTracker(TIGHT_LIMITS, clock.now);
    expect(budgets.remainingWallClockMs()).toBe(1_000);
    clock.advance(600);
    expect(budgets.remainingWallClockMs()).toBe(400);
    clock.advance(1_000);
    expect(budgets.remainingWallClockMs()).toBe(0);
  });
});

describe('@no-llm BudgetTracker cumulative bytes', () => {
  it('accumulates bytes across calls and denies once the run cap is exceeded', () => {
    const budgets = new BudgetTracker(TIGHT_LIMITS);
    expect(budgets.accountResultBytes(100).isOk).toBe(true);
    expect(budgets.accountResultBytes(100).isOk).toBe(true);
    expect(budgets.snapshot().cumulativeBytes).toBe(200);

    const over = budgets.accountResultBytes(100); // 300 > 250
    expect(over.isOk).toBe(false);
    if (!over.isOk) expect(over.error.limit).toBe('cumulative-bytes');
  });

  it('refuses to reserve a new call once cumulative bytes are exhausted', () => {
    const budgets = new BudgetTracker(TIGHT_LIMITS);
    budgets.accountResultBytes(300); // over the 250 cap
    const denied = budgets.reserveCall('web_search');
    expect(denied.isOk).toBe(false);
    if (!denied.isOk) expect(denied.error.limit).toBe('cumulative-bytes');
  });
});

describe('@no-llm BudgetTracker navigation/host budget', () => {
  it('counts a repeated host once against the host budget', () => {
    const budgets = new BudgetTracker(TIGHT_LIMITS);
    expect(budgets.reserveNavigation('example.com').isOk).toBe(true);
    expect(budgets.reserveNavigation('example.com').isOk).toBe(true); // same host, 2nd navigation
    expect(budgets.snapshot().hosts).toBe(1);
    expect(budgets.snapshot().navigations).toBe(2);
  });

  it('denies a navigation once the navigation cap is hit', () => {
    const budgets = new BudgetTracker(TIGHT_LIMITS);
    budgets.reserveNavigation('a.com');
    budgets.reserveNavigation('a.com');
    const over = budgets.reserveNavigation('a.com');
    expect(over.isOk).toBe(false);
    if (!over.isOk) expect(over.error.limit).toBe('navigations');
  });

  it('denies a new host once the distinct-host cap is hit', () => {
    const budgets = new BudgetTracker({ ...TIGHT_LIMITS, maxNavigations: 10 });
    expect(budgets.reserveNavigation('a.com').isOk).toBe(true);
    expect(budgets.reserveNavigation('b.com').isOk).toBe(true);
    const over = budgets.reserveNavigation('c.com');
    expect(over.isOk).toBe(false);
    if (!over.isOk) expect(over.error.limit).toBe('hosts');
  });
});

describe('@no-llm BudgetTracker property: reserved calls never exceed limits', () => {
  it('never lets accepted calls exceed the total or per-tool caps', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('web_search', 'web_fetch', 'script_run'), { maxLength: 200 }),
        (calls) => {
          const budgets = new BudgetTracker(DEFAULT_BUDGET_LIMITS);
          const accepted = new Map<string, number>();
          let total = 0;
          for (const tool of calls) {
            if (budgets.reserveCall(tool).isOk) {
              total += 1;
              accepted.set(tool, (accepted.get(tool) ?? 0) + 1);
            }
          }
          expect(total).toBeLessThanOrEqual(DEFAULT_BUDGET_LIMITS.totalToolCalls);
          for (const count of accepted.values()) {
            expect(count).toBeLessThanOrEqual(DEFAULT_BUDGET_LIMITS.perToolCalls);
          }
        },
      ),
    );
  });
});
