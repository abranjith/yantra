// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { checkHitTarget } from '../../../src/locator/injected/hit-target.js';

describe('@no-llm checkHitTarget', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('returns ok when elementFromPoint returns the target element', () => {
    const el = document.createElement('button');
    el.textContent = 'Click';
    document.body.appendChild(el);

    // Simulate element at center
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
      top: 10,
      left: 10,
      width: 100,
      height: 40,
      right: 110,
      bottom: 50,
      x: 10,
      y: 10,
      toJSON: () => ({}),
    } as DOMRect);

    vi.spyOn(document, 'elementFromPoint').mockReturnValue(el);

    const result = checkHitTarget(el);
    expect(result.kind).toBe('ok');
  });

  it('returns ok when elementFromPoint returns a descendant of the target', () => {
    const btn = document.createElement('button');
    const span = document.createElement('span');
    span.textContent = 'Inner';
    btn.appendChild(span);
    document.body.appendChild(btn);

    vi.spyOn(btn, 'getBoundingClientRect').mockReturnValue({
      top: 10,
      left: 10,
      width: 100,
      height: 40,
      right: 110,
      bottom: 50,
      x: 10,
      y: 10,
      toJSON: () => ({}),
    } as DOMRect);

    vi.spyOn(document, 'elementFromPoint').mockReturnValue(span);

    const result = checkHitTarget(btn);
    expect(result.kind).toBe('ok');
  });

  it('returns intercepted when a different element covers the target', () => {
    const el = document.createElement('button');
    el.textContent = 'Hidden button';
    document.body.appendChild(el);

    const overlay = document.createElement('div');
    overlay.setAttribute('data-testid', 'banner');
    document.body.appendChild(overlay);

    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
      top: 10,
      left: 10,
      width: 100,
      height: 40,
      right: 110,
      bottom: 50,
      x: 10,
      y: 10,
      toJSON: () => ({}),
    } as DOMRect);

    vi.spyOn(document, 'elementFromPoint').mockReturnValue(overlay);

    const result = checkHitTarget(el);
    expect(result.kind).toBe('intercepted');
    if (result.kind === 'intercepted') {
      expect(result.interceptor.tagName).toBe('div');
      expect(result.interceptor.testid).toBe('banner');
    }
  });

  it('returns outside_viewport when element center is outside window bounds', () => {
    const el = document.createElement('button');
    document.body.appendChild(el);

    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
      top: -100,
      left: -200,
      width: 50,
      height: 20,
      right: -150,
      bottom: -80,
      x: -200,
      y: -100,
      toJSON: () => ({}),
    } as DOMRect);

    const result = checkHitTarget(el);
    expect(result.kind).toBe('outside_viewport');
  });

  it('coordinates are set to element center in ok result', () => {
    const el = document.createElement('button');
    document.body.appendChild(el);

    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
      top: 100,
      left: 200,
      width: 60,
      height: 30,
      right: 260,
      bottom: 130,
      x: 200,
      y: 100,
      toJSON: () => ({}),
    } as DOMRect);

    vi.spyOn(document, 'elementFromPoint').mockReturnValue(el);

    const result = checkHitTarget(el);
    expect(result.coordinates.x).toBe(230); // 200 + 60/2
    expect(result.coordinates.y).toBe(115); // 100 + 30/2
  });
});
