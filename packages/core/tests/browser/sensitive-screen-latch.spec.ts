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
