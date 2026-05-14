// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  checkActionableState,
  isAttached,
  isBoundingRectStable,
  isEnabled,
  isVisible,
} from '../../../src/locator/injected/actionable.js';

function makeDomRect(overrides: Partial<DOMRect> = {}): DOMRect {
  return {
    top: 10, left: 10, bottom: 50, right: 110,
    width: 100, height: 40, x: 10, y: 10,
    toJSON: () => ({}),
    ...overrides,
  } as DOMRect;
}

describe('@no-llm isVisible', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('returns true for visible element with non-zero rect', () => {
    const el = document.createElement('button');
    document.body.appendChild(el);
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(makeDomRect());
    // JSDOM doesn't compute real styles, so mock getComputedStyle
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      visibility: 'visible', display: 'block', opacity: '1',
    } as CSSStyleDeclaration);
    expect(isVisible(el)).toBe(true);
  });

  it('returns false for element with zero-width rect', () => {
    const el = document.createElement('button');
    document.body.appendChild(el);
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(makeDomRect({ width: 0, height: 40 }));
    expect(isVisible(el)).toBe(false);
  });

  it('returns false for element with visibility:hidden', () => {
    const el = document.createElement('button');
    document.body.appendChild(el);
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(makeDomRect());
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      visibility: 'hidden', display: 'block', opacity: '1',
    } as CSSStyleDeclaration);
    expect(isVisible(el)).toBe(false);
  });

  it('returns false for element with display:none', () => {
    const el = document.createElement('button');
    document.body.appendChild(el);
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(makeDomRect());
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      visibility: 'visible', display: 'none', opacity: '1',
    } as CSSStyleDeclaration);
    expect(isVisible(el)).toBe(false);
  });
});

describe('@no-llm isEnabled', () => {
  it('returns true for a non-disabled button', () => {
    const el = document.createElement('button');
    expect(isEnabled(el)).toBe(true);
  });

  it('returns false for disabled button', () => {
    const el = document.createElement('button');
    el.disabled = true;
    expect(isEnabled(el)).toBe(false);
  });

  it('returns false for aria-disabled="true"', () => {
    const el = document.createElement('div');
    el.setAttribute('aria-disabled', 'true');
    expect(isEnabled(el)).toBe(false);
  });

  it('returns true for aria-disabled="false"', () => {
    const el = document.createElement('div');
    el.setAttribute('aria-disabled', 'false');
    expect(isEnabled(el)).toBe(true);
  });
});

describe('@no-llm isAttached', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('returns true for element in the document', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    expect(isAttached(el)).toBe(true);
  });

  it('returns false for detached element', () => {
    const el = document.createElement('div');
    expect(isAttached(el)).toBe(false);
  });
});

describe('@no-llm isBoundingRectStable', () => {
  it('returns true when both rects are identical', () => {
    const r1 = makeDomRect({ top: 10, left: 20, width: 100, height: 40 });
    const r2 = makeDomRect({ top: 10, left: 20, width: 100, height: 40 });
    expect(isBoundingRectStable(r1, r2)).toBe(true);
  });

  it('returns false when top differs', () => {
    const r1 = makeDomRect({ top: 10 });
    const r2 = makeDomRect({ top: 15 });
    expect(isBoundingRectStable(r1, r2)).toBe(false);
  });

  it('returns false when width differs (animation in progress)', () => {
    const r1 = makeDomRect({ width: 100 });
    const r2 = makeDomRect({ width: 105 });
    expect(isBoundingRectStable(r1, r2)).toBe(false);
  });
});

describe('@no-llm checkActionableState', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('returns all-false when element has zero rect', () => {
    const el = document.createElement('button');
    document.body.appendChild(el);
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(
      makeDomRect({ width: 0, height: 0 }),
    );
    const state = checkActionableState(el);
    expect(state.visible).toBe(false);
  });

  it('stable is always true from single snapshot', () => {
    const el = document.createElement('button');
    document.body.appendChild(el);
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(makeDomRect());
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      visibility: 'visible', display: 'block', opacity: '1',
    } as CSSStyleDeclaration);
    const state = checkActionableState(el);
    expect(state.stable).toBe(true);
  });

  it('enabled is false for disabled input', () => {
    const input = document.createElement('input');
    input.disabled = true;
    document.body.appendChild(input);
    const state = checkActionableState(input);
    expect(state.enabled).toBe(false);
  });
});
