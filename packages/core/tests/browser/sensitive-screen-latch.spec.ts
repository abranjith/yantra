import { describe, expect, it } from 'vitest';

import { SensitiveScreenLatch } from '../../src/browser/sensitive-screen-latch.js';

describe('@no-llm SensitiveScreenLatch', () => {
  it('stays latched through ordinary actions and same-document SPA activity', () => {
    const latch = new SensitiveScreenLatch();
    latch.latch(4);
    for (let action = 0; action < 20; action += 1) {
      expect(latch.isLatched(4)).toBe(true);
    }
  });

  it('clears only after a top-level epoch bump', () => {
    const latch = new SensitiveScreenLatch();
    latch.latch(4);
    expect(latch.isLatched(4)).toBe(true);
    expect(latch.isLatched(5)).toBe(false);
    expect(latch.isLatched(5)).toBe(false);
  });

  it.each([null, undefined, Number.NaN, -1])('keeps uncertainty latched for epoch %s', (epoch) => {
    const latch = new SensitiveScreenLatch();
    latch.latch(4);
    expect(latch.isLatched(epoch)).toBe(true);
  });

  it('keeps an unreadable latch epoch denied until teardown', () => {
    const latch = new SensitiveScreenLatch();
    latch.latch(null);
    expect(latch.isLatched(99)).toBe(true);
    latch.clearOnTeardown();
    expect(latch.isLatched(null)).toBe(false);
  });

  it('does not clear for conceptual click, mutation, dialog, subframe, or timer events', () => {
    const latch = new SensitiveScreenLatch();
    latch.latch(7);
    for (const _event of ['click', 'mutation', 'dialog', 'subframe-navigation', 'timer']) {
      expect(latch.isLatched(7)).toBe(true);
    }
  });
});

describe('@no-llm SensitiveScreenLatch subscribe (FEAT-069)', () => {
  it('pushes true synchronously inside latch()', () => {
    const latch = new SensitiveScreenLatch();
    const seen: boolean[] = [];
    latch.subscribe((latched) => seen.push(latched));
    latch.latch(3);
    expect(seen).toEqual([true]);
  });

  it('pushes false when an epoch change clears it, and only once', () => {
    const latch = new SensitiveScreenLatch();
    const seen: boolean[] = [];
    latch.subscribe((latched) => seen.push(latched));
    latch.latch(3);
    latch.isLatched(4);
    latch.isLatched(4);
    latch.isLatched(5);
    expect(seen).toEqual([true, false]);
  });

  it('never fires on a repeated read of the same epoch or an unreadable one', () => {
    const latch = new SensitiveScreenLatch();
    const seen: boolean[] = [];
    latch.latch(3);
    latch.subscribe((latched) => seen.push(latched));
    for (const epoch of [3, 3, null, undefined, -1, Number.NaN]) latch.isLatched(epoch);
    expect(seen).toEqual([]);
  });

  it('does not notify again when re-latched while latched, but tracks the new epoch', () => {
    const latch = new SensitiveScreenLatch();
    const seen: boolean[] = [];
    latch.subscribe((latched) => seen.push(latched));
    latch.latch(3);
    latch.latch(4);
    expect(seen).toEqual([true]);
    expect(latch.isLatched(4)).toBe(true);
    expect(latch.isLatched(5)).toBe(false);
    expect(seen).toEqual([true, false]);
  });

  it('pushes false on teardown only when it was latched', () => {
    const latch = new SensitiveScreenLatch();
    const seen: boolean[] = [];
    latch.subscribe((latched) => seen.push(latched));
    latch.clearOnTeardown();
    expect(seen).toEqual([]);
    latch.latch(null);
    latch.clearOnTeardown();
    expect(seen).toEqual([true, false]);
  });

  it('stops delivery after unsubscribe', () => {
    const latch = new SensitiveScreenLatch();
    const seen: boolean[] = [];
    const unsubscribe = latch.subscribe((latched) => seen.push(latched));
    unsubscribe();
    latch.latch(1);
    expect(seen).toEqual([]);
  });

  it('notifies every listener after the state changed, then rethrows the first listener error', () => {
    const latch = new SensitiveScreenLatch();
    const states: boolean[] = [];
    latch.subscribe(() => {
      throw new Error('first');
    });
    latch.subscribe(() => states.push(latch.isLatched(null)));
    latch.subscribe(() => {
      throw new Error('second');
    });
    expect(() => latch.latch(2)).toThrow('first');
    expect(states).toEqual([true]);
    expect(latch.isLatched(2)).toBe(true);
  });
});
