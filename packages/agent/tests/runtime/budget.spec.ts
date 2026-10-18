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

describe('@no-llm BudgetTracker capture budgets', () => {
  it('reserves captures one through three and denies the fourth by name', () => {
    const budgets = new BudgetTracker(TIGHT_LIMITS);
    for (let count = 1; count <= 3; count += 1) {
      expect(budgets.reserveCapture().isOk).toBe(true);
      expect(budgets.snapshot().captureCount).toBe(count);
    }
    const denied = budgets.reserveCapture();
    expect(denied.isOk).toBe(false);
    if (!denied.isOk) expect(denied.error.limit).toBe('capture-count');
  });

  it.each([
    [1600, 1200, true],
    [1601, 1200, false],
    [1600, 1201, false],
  ])('checks the %sx%s pixel boundary', (width, height, allowed) => {
    const result = new BudgetTracker(TIGHT_LIMITS).accountCaptureBytes({
      mimeType: 'image/png',
      width,
      height,
      bytes: 1,
    });
    expect(result.isOk).toBe(allowed);
    if (!result.isOk) expect(result.error.limit).toBe('capture-pixels');
  });

  it.each([
    [5 * 1024 * 1024, true],
    [5 * 1024 * 1024 + 1, false],
  ])('checks encoded byte boundary %s', (bytes, allowed) => {
    const result = new BudgetTracker(TIGHT_LIMITS).accountCaptureBytes({
      mimeType: 'image/png',
      width: 1,
      height: 1,
      bytes,
    });
    expect(result.isOk).toBe(allowed);
    if (!result.isOk) expect(result.error.limit).toBe('capture-bytes');
  });

  it('rejects non-PNG encodings', () => {
    const result = new BudgetTracker(TIGHT_LIMITS).accountCaptureBytes({
      mimeType: 'image/jpeg',
      width: 1,
      height: 1,
      bytes: 1,
    });
    expect(result.isOk).toBe(false);
    if (!result.isOk) expect(result.error.limit).toBe('capture-mime');
  });

  it.each([
    ['width NaN', Number.NaN, 1, 1],
    ['width undefined', undefined, 1, 1],
    ['width negative', -1, 1, 1],
    ['height NaN', 1, Number.NaN, 1],
    ['height undefined', 1, undefined, 1],
    ['height negative', 1, -1, 1],
    ['bytes NaN', 1, 1, Number.NaN],
    ['bytes undefined', 1, 1, undefined],
    ['bytes negative', 1, 1, -1],
  ] as const)('fails closed for %s', (_label, width, height, bytes) => {
    const result = new BudgetTracker(TIGHT_LIMITS).accountCaptureBytes({
      mimeType: 'image/png',
      width,
      height,
      bytes,
    });
    expect(result.isOk).toBe(false);
  });

  it('keeps accepted image bytes separate from cumulative text bytes', () => {
    const budgets = new BudgetTracker(TIGHT_LIMITS);
    budgets.accountResultBytes(10);
    budgets.reserveCapture();
    budgets.accountCaptureBytes({ mimeType: 'image/png', width: 10, height: 10, bytes: 200 });
    expect(budgets.snapshot()).toMatchObject({
      cumulativeBytes: 10,
      captureCount: 1,
      capturePixels: 100,
      captureBytes: 200,
    });
  });
});

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

describe('@no-llm BudgetTracker wind-down exemption (FEAT-054 S1)', () => {
  it('reserves a wind-down-exempt call after the soft boundary while exploration is refused', () => {
    const clock = fakeClock();
    const budgets = new BudgetTracker(TIGHT_LIMITS, clock.now);
    clock.advance(800);

    expect(budgets.reserveCall('task_contract', { windDownExempt: true }).isOk).toBe(true);
    const fetch = budgets.reserveCall('web_fetch');
    expect(fetch.isOk).toBe(false);
    if (!fetch.isOk) expect(fetch.error.limit).toBe('wall-clock-soft');
  });

  it('still refuses a wind-down-exempt call after the hard boundary', () => {
    const clock = fakeClock();
    const budgets = new BudgetTracker(TIGHT_LIMITS, clock.now);
    clock.advance(1_000);

    const refused = budgets.reserveCall('task_contract', { windDownExempt: true });
    expect(refused.isOk).toBe(false);
    if (!refused.isOk) expect(refused.error.limit).toBe('wall-clock');
  });

  it('does not exempt a wind-down-exempt call from the cumulative-byte cap', () => {
    const budgets = new BudgetTracker(TIGHT_LIMITS);
    budgets.accountResultBytes(250);

    const refused = budgets.reserveCall('task_contract', { windDownExempt: true });
    expect(refused.isOk).toBe(false);
    if (!refused.isOk) expect(refused.error.limit).toBe('cumulative-bytes');
  });

  it('records softWindDownReached once a call meets the soft boundary, not before', () => {
    const clock = fakeClock();
    const budgets = new BudgetTracker(TIGHT_LIMITS, clock.now);
    budgets.reserveCall('web_search');
    expect(budgets.softWindDownReached).toBe(false);

    clock.advance(800);
    expect(budgets.softWindDownReached).toBe(false);
    expect(budgets.reserveCall('web_search').isOk).toBe(false);
    expect(budgets.softWindDownReached).toBe(true);
  });

  it('records softWindDownReached when only the terminal call crosses the boundary', () => {
    const clock = fakeClock();
    const budgets = new BudgetTracker(TIGHT_LIMITS, clock.now);
    clock.advance(900);

    expect(budgets.reserveCall('result_publish', { terminal: true }).isOk).toBe(true);
    expect(budgets.softWindDownReached).toBe(true);
  });
});

describe('@no-llm BudgetTracker deliverable capture budget (FEAT-058 S4)', () => {
  const MIB = 1024 * 1024;
  const file = (bytes = 1000, width = 1920, height = 4096) => ({ width, height, bytes });

  it('ships the S4 limits as configuration constants', () => {
    expect(DEFAULT_BUDGET_LIMITS).toMatchObject({
      maxDeliverableCaptures: 4,
      maxDeliverablePartsPerCall: 6,
      maxDeliverableTileWidth: 1920,
      maxDeliverableTileHeight: 4096,
      maxDeliverableFileBytes: 8 * MIB,
      maxDeliverableBytesPerRun: 40 * MIB,
    });
    // Vision Assist's limits do not move.
    expect(DEFAULT_BUDGET_LIMITS).toMatchObject({
      maxCaptures: 3,
      maxCapturePixels: 1600 * 1200,
      maxCaptureBytes: 5 * MIB,
    });
  });

  it('reserves four calls with ordinals 1 to 4 and refuses the fifth by name', () => {
    const budgets = new BudgetTracker(TIGHT_LIMITS);
    for (let seq = 1; seq <= 4; seq += 1) {
      const reserved = budgets.reserveDeliverableCapture();
      expect(reserved.isOk && reserved.value).toBe(seq);
      expect(budgets.remainingDeliverableCaptures()).toBe(4 - seq);
    }
    const denied = budgets.reserveDeliverableCapture();
    expect(denied.isOk).toBe(false);
    if (!denied.isOk) {
      expect(denied.error.limit).toBe('deliverable-capture-count');
      expect(denied.error.carriesPublishRemedy).toBe(true);
    }
  });

  it('never touches the Vision Assist counters, and Vision never touches it', () => {
    const budgets = new BudgetTracker(TIGHT_LIMITS);
    budgets.reserveDeliverableCapture();
    budgets.accountDeliverableBytes([file()]);
    budgets.reserveCapture();
    expect(budgets.snapshot()).toMatchObject({
      captureCount: 1,
      captureBytes: 0,
      deliverableCaptureCount: 1,
      deliverableCaptureBytes: 1000,
    });
    expect(budgets.remainingCaptures()).toBe(2);
  });

  it('accepts a tile at exactly the pixel and byte bounds', () => {
    const budgets = new BudgetTracker(TIGHT_LIMITS);
    expect(budgets.accountDeliverableBytes([file(8 * MIB)]).isOk).toBe(true);
  });

  it.each([
    ['one pixel too wide', file(1000, 1921, 10), 'deliverable-capture-pixels'],
    ['one pixel too tall', file(1000, 10, 4097), 'deliverable-capture-pixels'],
    ['zero width', file(1000, 0, 10), 'deliverable-capture-pixels'],
    ['fractional height', file(1000, 10, 1.5), 'deliverable-capture-pixels'],
    ['one byte too large', file(8 * MIB + 1), 'deliverable-capture-bytes'],
    ['negative bytes', file(-1), 'deliverable-capture-bytes'],
  ] as const)('refuses a file %s and accounts nothing', (_label, measurement, limit) => {
    const budgets = new BudgetTracker(TIGHT_LIMITS);
    const result = budgets.accountDeliverableBytes([file(), measurement]);
    expect(result.isOk).toBe(false);
    if (!result.isOk) expect(result.error.limit).toBe(limit);
    expect(budgets.snapshot().deliverableCaptureBytes).toBe(0);
  });

  it('refuses zero files and more than six files per call', () => {
    const budgets = new BudgetTracker(TIGHT_LIMITS);
    expect(budgets.accountDeliverableBytes([]).isOk).toBe(false);
    expect(budgets.accountDeliverableBytes(Array.from({ length: 7 }, () => file())).isOk).toBe(
      false,
    );
    expect(budgets.accountDeliverableBytes(Array.from({ length: 6 }, () => file())).isOk).toBe(
      true,
    );
  });

  it('refuses a call that would cross the 40 MiB run total, atomically', () => {
    const budgets = new BudgetTracker(TIGHT_LIMITS);
    for (let call = 0; call < 5; call += 1) {
      expect(budgets.accountDeliverableBytes([file(8 * MIB)]).isOk).toBe(true);
    }
    const over = budgets.accountDeliverableBytes([file(1)]);
    expect(over.isOk).toBe(false);
    if (!over.isOk) expect(over.error.limit).toBe('deliverable-capture-bytes');
    expect(budgets.snapshot().deliverableCaptureBytes).toBe(40 * MIB);
  });

  it('exposes the per-call bounds the controller obeys', () => {
    expect(new BudgetTracker(TIGHT_LIMITS).deliverableBounds()).toEqual({
      tileWidth: 1920,
      tileHeight: 4096,
      maxParts: 6,
    });
  });
});

describe('@no-llm FEAT-059 exploration reservation', () => {
  it('separates exploration from fixed publication headroom and handles infinity', () => {
    const clock = fakeClock(0);
    const budget = new BudgetTracker({ ...DEFAULT_BUDGET_LIMITS, wallClockMs: 900000 }, clock.now);
    clock.advance(300000);
    expect(budget.explorationRemainingMs()).toBe(420000);
    expect(budget.publicationHeadroomMs()).toBe(180000);
    clock.advance(480000);
    expect(budget.explorationRemainingMs()).toBe(0);
    const unbounded = new BudgetTracker({ ...DEFAULT_BUDGET_LIMITS, wallClockMs: Infinity });
    expect(unbounded.explorationRemainingMs()).toBeNull();
    expect(unbounded.publicationHeadroomMs()).toBeNull();
  });
  it('freezes exploration idempotently, counts refusals, and preserves terminal and exempt calls', () => {
    const budget = new BudgetTracker(DEFAULT_BUDGET_LIMITS);
    budget.freezeExploration();
    budget.freezeExploration();
    for (let i = 1; i <= 2; i++) {
      const result = budget.reserveCall('web_fetch');
      expect(result.isOk).toBe(false);
      if (!result.isOk)
        expect(result.error).toMatchObject({ limit: 'stalled', carriesPublishRemedy: true });
      expect(budget.refusedAfterFreeze()).toBe(i);
    }
    expect(budget.reserveCall('result_publish', { terminal: true }).isOk).toBe(true);
    expect(budget.reserveCall('task_contract', { windDownExempt: true }).isOk).toBe(true);
  });
});
