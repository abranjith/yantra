// @no-llm
import { describe, expect, it } from 'vitest';

import { ScreenProtection, withProtectionHold } from '../../src/browser/screen-protection.js';
import { SensitiveScreenLatch } from '../../src/browser/sensitive-screen-latch.js';

function protection(): { latch: SensitiveScreenLatch; screen: ScreenProtection; seen: boolean[] } {
  const latch = new SensitiveScreenLatch();
  const screen = new ScreenProtection(latch);
  const seen: boolean[] = [];
  screen.subscribe((value) => seen.push(value));
  return { latch, screen, seen };
}

describe('@no-llm ScreenProtection', () => {
  it('starts unprotected', () => {
    const { screen } = protection();
    expect(screen.isProtectedNow).toBe(false);
    expect(screen.isProtected(0)).toBe(false);
    expect(screen.focusState).toBe('clear');
    expect(screen.openHolds).toBe(0);
  });

  it('starts protected over a latch that is already set', () => {
    const latch = new SensitiveScreenLatch();
    latch.latch(1);
    expect(new ScreenProtection(latch).isProtectedNow).toBe(true);
  });

  it('follows the latch, and clears when an epoch change is evaluated', () => {
    const { latch, screen, seen } = protection();
    latch.latch(4);
    expect(screen.isProtectedNow).toBe(true);
    expect(screen.isProtected(4)).toBe(true);
    expect(screen.isProtected(5)).toBe(false);
    expect(seen).toEqual([true, false]);
  });

  it('stays protected through an unreadable epoch', () => {
    const { latch, screen } = protection();
    latch.latch(4);
    expect(screen.isProtected(null)).toBe(true);
    expect(screen.isProtected(undefined)).toBe(true);
  });

  it('nests holds, and a double release is a no-op', () => {
    const { screen, seen } = protection();
    const first = screen.hold('masked_fill');
    const second = screen.hold('secret_fill');
    expect(screen.openHolds).toBe(2);
    first();
    first();
    expect(screen.openHolds).toBe(1);
    expect(screen.isProtectedNow).toBe(true);
    second();
    expect(screen.openHolds).toBe(0);
    expect(screen.isProtectedNow).toBe(false);
    expect(seen).toEqual([true, false]);
  });

  it.each(['protected', 'unknown'] as const)('treats %s focus as protected', (focus) => {
    const { screen } = protection();
    screen.setFocus(focus);
    expect(screen.isProtectedNow).toBe(true);
    screen.setFocus('clear');
    expect(screen.isProtectedNow).toBe(false);
  });

  it('fires once per combined transition, not once per input', () => {
    const { latch, screen, seen } = protection();
    latch.latch(1);
    const release = screen.hold('masked_fill');
    screen.setFocus('unknown');
    screen.setFocus('protected');
    screen.setFocus('protected');
    expect(seen).toEqual([true]);
    screen.setFocus('clear');
    release();
    expect(seen).toEqual([true]);
    screen.isProtected(2);
    expect(seen).toEqual([true, false]);
  });

  it('clears with the latch on teardown when nothing else holds', () => {
    const { latch, screen, seen } = protection();
    latch.latch(null);
    latch.clearOnTeardown();
    expect(screen.isProtectedNow).toBe(false);
    expect(seen).toEqual([true, false]);
  });

  it('keeps a hold protecting after the latch clears', () => {
    const { latch, screen, seen } = protection();
    latch.latch(1);
    const release = screen.hold('masked_fill');
    screen.isProtected(2);
    expect(screen.isProtectedNow).toBe(true);
    release();
    expect(seen).toEqual([true, false]);
  });

  it('stops delivery after unsubscribe', () => {
    const latch = new SensitiveScreenLatch();
    const screen = new ScreenProtection(latch);
    const seen: boolean[] = [];
    const unsubscribe = screen.subscribe((value) => seen.push(value));
    unsubscribe();
    latch.latch(1);
    expect(seen).toEqual([]);
  });

  it('runs the other listeners and rethrows the first error', () => {
    const { screen } = protection();
    const later: boolean[] = [];
    screen.subscribe(() => {
      throw new Error('broken');
    });
    screen.subscribe((value) => later.push(value));
    expect(() => screen.setFocus('protected')).toThrow('broken');
    expect(later).toEqual([true]);
    expect(screen.isProtectedNow).toBe(true);
  });
});

describe('@no-llm withProtectionHold', () => {
  it('holds while the operation runs and releases on success', async () => {
    const { screen } = protection();
    const during = await withProtectionHold(screen, 'masked_fill', () =>
      Promise.resolve(screen.isProtectedNow),
    );
    expect(during).toBe(true);
    expect(screen.isProtectedNow).toBe(false);
  });

  it('releases when the operation throws', async () => {
    const { screen } = protection();
    await expect(
      withProtectionHold(screen, 'masked_fill', () => Promise.reject(new Error('fill failed'))),
    ).rejects.toThrow('fill failed');
    expect(screen.openHolds).toBe(0);
  });

  it('just runs the operation without a protection', async () => {
    await expect(
      withProtectionHold(undefined, 'masked_fill', () => Promise.resolve(7)),
    ).resolves.toBe(7);
    await expect(withProtectionHold(null, 'masked_fill', () => Promise.resolve(8))).resolves.toBe(
      8,
    );
  });
});
