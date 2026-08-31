import { describe, expect, it } from 'vitest';

import {
  BudgetTracker,
  DEFAULT_BUDGET_LIMITS,
  type BudgetLimits,
} from '../../src/runtime/budget.js';

function fakeClock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return { now: () => current, advance: (ms) => (current += ms) };
}

const TIGHT_LIMITS: BudgetLimits = {
  wallClockMs: 1_000,
  softWallClockFraction: 0.8,
  perToolTimeoutMs: 500,
  maxBytesPerResult: 100,
  maxBytesPerRun: 250,
  maxNavigations: 2,
  maxHosts: 2,
};

describe('@no-llm BudgetTracker call reservation', () => {
  it('records arbitrarily many calls without enforcing total or per-tool call caps', () => {
    const budgets = new BudgetTracker(TIGHT_LIMITS);

    for (let index = 0; index < 1_000; index += 1) {
      expect(budgets.reserveCall(index % 2 === 0 ? 'web_search' : 'web_fetch').isOk).toBe(true);
    }

    expect(budgets.snapshot()).toMatchObject({
      totalCalls: 1_000,
      perToolCalls: { web_search: 500, web_fetch: 500 },
    });
  });

  it('does not consume a call when cumulative bytes deny the reservation', () => {
    const budgets = new BudgetTracker(TIGHT_LIMITS);
    expect(budgets.accountResultBytes(251).isOk).toBe(false);
    expect(budgets.reserveCall('web_search').isOk).toBe(false);
    expect(budgets.snapshot().totalCalls).toBe(0);
  });
});

describe('@no-llm BudgetTracker terminal-call exemption', () => {
  it('grants terminal publication after cumulative bytes are spent', () => {
    const budgets = new BudgetTracker(TIGHT_LIMITS);
    budgets.accountResultBytes(300);

    const exploration = budgets.reserveCall('web_fetch');
    expect(exploration.isOk).toBe(false);
    if (!exploration.isOk) expect(exploration.error.limit).toBe('cumulative-bytes');
    expect(budgets.reserveCall('result_publish', { terminal: true }).isOk).toBe(true);
  });

  it('records but never rejects terminal result bytes', () => {
    const budgets = new BudgetTracker(TIGHT_LIMITS);
    budgets.accountResultBytes(200);

    expect(budgets.accountResultBytes(100, { terminal: true }).isOk).toBe(true);
    expect(budgets.snapshot().cumulativeBytes).toBe(300);
  });

  it('still binds terminal publication to the hard wall clock', () => {
    const clock = fakeClock();
    const budgets = new BudgetTracker(TIGHT_LIMITS, clock.now);
    clock.advance(1_000);

    const denied = budgets.reserveCall('result_publish', { terminal: true });
    expect(denied.isOk).toBe(false);
    if (!denied.isOk) expect(denied.error.limit).toBe('wall-clock');
  });
});

describe('@no-llm BudgetTracker two-phase wall clock', () => {
  it('soft-stops exploration at 80%, permits publication, and hard-stops every call at 100%', () => {
    const clock = fakeClock();
    const budgets = new BudgetTracker(TIGHT_LIMITS, clock.now);

    clock.advance(799);
    expect(budgets.reserveCall('web_search').isOk).toBe(true);

    clock.advance(1);
    const soft = budgets.reserveCall('web_search');
    expect(soft.isOk).toBe(false);
    if (!soft.isOk) {
      expect(soft.error.limit).toBe('wall-clock-soft');
      expect(soft.error.message).toMatch(/publish now.*evidence already gathered/i);
      // The decision knows it already carries the remedy, so the caller does
      // not append a second, near-identical one.
      expect(soft.error.carriesPublishRemedy).toBe(true);
    }

    clock.advance(100);
    expect(budgets.reserveCall('result_publish', { terminal: true }).isOk).toBe(true);

    clock.advance(100);
    for (const terminal of [false, true]) {
      const hard = budgets.reserveCall(terminal ? 'result_publish' : 'web_search', { terminal });
      expect(hard.isOk).toBe(false);
      if (!hard.isOk) expect(hard.error.limit).toBe('wall-clock');
    }
  });

  it('marks a refusal that carries no publish remedy of its own', () => {
    // The cumulative-byte refusal says nothing about publishing, so the caller
    // is the right place for that sentence — and the only place.
    const clock = fakeClock();
    const budgets = new BudgetTracker(TIGHT_LIMITS, clock.now);

    budgets.accountResultBytes(TIGHT_LIMITS.maxBytesPerRun + 1);
    const denied = budgets.reserveCall('web_search');

    expect(denied.isOk).toBe(false);
    if (denied.isOk) return;
    expect(denied.error.limit).toBe('cumulative-bytes');
    expect(denied.error.carriesPublishRemedy).toBe(false);
  });

  it('moves the wind-down boundary with a custom fraction', () => {
    const clock = fakeClock();
    const budgets = new BudgetTracker({ ...TIGHT_LIMITS, softWallClockFraction: 0.5 }, clock.now);

    clock.advance(499);
    expect(budgets.reserveCall('web_search').isOk).toBe(true);
    clock.advance(1);
    const denied = budgets.reserveCall('web_search');
    expect(denied.isOk).toBe(false);
    if (!denied.isOk) expect(denied.error.limit).toBe('wall-clock-soft');
  });

  it('uses a finite 15-minute hard default with a 12-minute wind-down', () => {
    expect(DEFAULT_BUDGET_LIMITS.wallClockMs).toBe(15 * 60 * 1_000);
    expect(DEFAULT_BUDGET_LIMITS.softWallClockFraction).toBe(0.8);
  });

  it('reports remaining hard-wall-clock time clamped at zero', () => {
    const clock = fakeClock();
    const budgets = new BudgetTracker(TIGHT_LIMITS, clock.now);
    expect(budgets.remainingWallClockMs()).toBe(1_000);
    clock.advance(600);
    expect(budgets.remainingWallClockMs()).toBe(400);
    clock.advance(1_000);
    expect(budgets.remainingWallClockMs()).toBe(0);
  });
});

describe('@no-llm BudgetTracker byte, navigation, and host boundaries', () => {
  it('accepts cumulative bytes at the cap and rejects the byte beyond it', () => {
    const budgets = new BudgetTracker(TIGHT_LIMITS);
    expect(budgets.accountResultBytes(250).isOk).toBe(true);
    const over = budgets.accountResultBytes(1);
    expect(over.isOk).toBe(false);
    if (!over.isOk) expect(over.error.limit).toBe('cumulative-bytes');
  });

  it('rejects the navigation beyond the cap', () => {
    const budgets = new BudgetTracker(TIGHT_LIMITS);
    expect(budgets.reserveNavigation('a.com').isOk).toBe(true);
    expect(budgets.reserveNavigation('a.com').isOk).toBe(true);
    const over = budgets.reserveNavigation('a.com');
    expect(over.isOk).toBe(false);
    if (!over.isOk) expect(over.error.limit).toBe('navigations');
  });

  it('rejects the distinct host beyond the cap while counting repeats once', () => {
    const budgets = new BudgetTracker({ ...TIGHT_LIMITS, maxNavigations: 10 });
    expect(budgets.reserveNavigation('a.com').isOk).toBe(true);
    expect(budgets.reserveNavigation('a.com').isOk).toBe(true);
    expect(budgets.reserveNavigation('b.com').isOk).toBe(true);
    const over = budgets.reserveNavigation('c.com');
    expect(over.isOk).toBe(false);
    if (!over.isOk) expect(over.error.limit).toBe('hosts');
  });
});
