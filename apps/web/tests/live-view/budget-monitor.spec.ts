// @no-llm
/**
 * Automatic Solid (FEAT-069 TASK-011): the budget monitor on a stepped clock.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  BUDGET_MAX_SHARE,
  BUDGET_MIN_FPS,
  BUDGET_WINDOW_MS,
  BudgetMonitor,
  solidAlready,
} from '../../src/live-view/budget-monitor.js';

function stepped() {
  let now = 0;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

/** Feeds one 5-second window: `offered` and `drawn` fps, `busyShare` of the window. */
function feed(
  monitor: BudgetMonitor,
  clock: ReturnType<typeof stepped>,
  { offered, drawn, busyShare = 0 }: { offered: number; drawn: number; busyShare?: number },
): void {
  const frames = Math.max(offered, 1) * (BUDGET_WINDOW_MS / 1000);
  const step = BUDGET_WINDOW_MS / frames;
  const drawEvery = offered === 0 ? Infinity : offered / Math.max(drawn, 1e-9);
  const busyPerFrame = (busyShare * BUDGET_WINDOW_MS) / frames;
  for (let index = 0; index < frames; index += 1) {
    if (offered > 0) monitor.frameOffered(busyPerFrame / 2);
    if (drawn > 0 && index % Math.round(drawEvery) === 0) monitor.frameDrawn(busyPerFrame / 2);
    else if (offered > 0) monitor.addBusy(busyPerFrame / 2);
    clock.advance(step);
  }
  monitor.tick();
}

describe('BudgetMonitor', () => {
  it('does not switch for a single slow window', () => {
    const clock = stepped();
    const onOverBudget = vi.fn();
    const monitor = new BudgetMonitor({ now: clock.now, onOverBudget });
    feed(monitor, clock, { offered: 10, drawn: 2 });
    feed(monitor, clock, { offered: 10, drawn: 10 });
    expect(monitor.windows.map((window) => window.overBudget)).toEqual([true, false]);
    expect(onOverBudget).not.toHaveBeenCalled();
    expect(monitor.verdict).toBe('ok');
  });

  it('switches once after two consecutive slow windows', () => {
    const clock = stepped();
    const onOverBudget = vi.fn();
    const monitor = new BudgetMonitor({ now: clock.now, onOverBudget });
    feed(monitor, clock, { offered: 10, drawn: 2 });
    feed(monitor, clock, { offered: 10, drawn: 2 });
    feed(monitor, clock, { offered: 10, drawn: 2 });
    feed(monitor, clock, { offered: 10, drawn: 2 });
    expect(onOverBudget).toHaveBeenCalledTimes(1);
    expect(monitor.verdict).toBe('over_budget');
  });

  it('never switches while the worker offers little (idle worker, static page)', () => {
    const clock = stepped();
    const onOverBudget = vi.fn();
    const monitor = new BudgetMonitor({ now: clock.now, onOverBudget });
    for (let index = 0; index < 4; index += 1) feed(monitor, clock, { offered: 1, drawn: 0 });
    for (let index = 0; index < 4; index += 1) {
      clock.advance(BUDGET_WINDOW_MS);
      monitor.tick();
    }
    expect(onOverBudget).not.toHaveBeenCalled();
    expect(monitor.windows.every((window) => !window.overBudget)).toBe(true);
  });

  it('switches on a CPU-share breach alone, at full frame rate', () => {
    const clock = stepped();
    const onOverBudget = vi.fn();
    const monitor = new BudgetMonitor({ now: clock.now, onOverBudget });
    feed(monitor, clock, { offered: 10, drawn: 10, busyShare: BUDGET_MAX_SHARE + 0.05 });
    feed(monitor, clock, { offered: 10, drawn: 10, busyShare: BUDGET_MAX_SHARE + 0.05 });
    expect(monitor.windows.at(-1)!.drawnFps).toBeGreaterThanOrEqual(BUDGET_MIN_FPS);
    expect(onOverBudget).toHaveBeenCalledTimes(1);
  });

  it('stays quiet at exactly the budget', () => {
    const clock = stepped();
    const onOverBudget = vi.fn();
    const monitor = new BudgetMonitor({ now: clock.now, onOverBudget });
    feed(monitor, clock, { offered: 5, drawn: 5, busyShare: BUDGET_MAX_SHARE - 0.01 });
    feed(monitor, clock, { offered: 5, drawn: 5, busyShare: BUDGET_MAX_SHARE - 0.01 });
    expect(onOverBudget).not.toHaveBeenCalled();
  });

  it('does nothing when disabled (a Solid preference or reduced transparency)', () => {
    const clock = stepped();
    const onOverBudget = vi.fn();
    const monitor = new BudgetMonitor({ now: clock.now, onOverBudget, disabled: true });
    feed(monitor, clock, { offered: 10, drawn: 1 });
    feed(monitor, clock, { offered: 10, drawn: 1 });
    expect(onOverBudget).not.toHaveBeenCalled();
    expect(monitor.verdict).toBe('ok');
  });

  it('counts quiet windows through tick, which resets the streak', () => {
    const clock = stepped();
    const onOverBudget = vi.fn();
    const monitor = new BudgetMonitor({ now: clock.now, onOverBudget });
    feed(monitor, clock, { offered: 10, drawn: 2 });
    clock.advance(BUDGET_WINDOW_MS);
    monitor.tick();
    feed(monitor, clock, { offered: 10, drawn: 2 });
    expect(onOverBudget).not.toHaveBeenCalled();
  });

  it('ignores negative busy time', () => {
    const clock = stepped();
    const monitor = new BudgetMonitor({ now: clock.now });
    monitor.addBusy(-500);
    clock.advance(BUDGET_WINDOW_MS);
    monitor.tick();
    expect(monitor.windows[0]!.share).toBe(0);
  });
});

describe('solidAlready', () => {
  it('is true for a Solid preference on the root', () => {
    const root = document.createElement('html');
    root.dataset.surfaces = 'solid';
    expect(solidAlready(root)).toBe(true);
  });

  it('is true when the OS asks for reduced transparency', () => {
    const root = document.createElement('html');
    root.dataset.surfaces = 'glass';
    const matchMedia = (query: string) =>
      ({ matches: query.includes('reduced-transparency') }) as MediaQueryList;
    expect(solidAlready(root, matchMedia)).toBe(true);
  });

  it('is false for Glass with no OS preference', () => {
    const root = document.createElement('html');
    root.dataset.surfaces = 'glass';
    expect(solidAlready(root, () => ({ matches: false }) as MediaQueryList)).toBe(false);
  });
});
