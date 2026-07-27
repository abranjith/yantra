// @vitest-environment jsdom

/**
 * Injected `resolveCandidate` — match-set narrowing.
 *
 * Record time only ever sees visible elements (the observation scanner filters
 * on visibility), so a chain pinned from a recording resolves at replay against
 * a strictly larger set than it was derived from. Real pages are full of
 * duplicate markup that is never on screen — a mobile copy of the desktop nav,
 * a collapsed menu, an off-screen template — and every one of those turned an
 * unambiguous locator into a strict-mode ambiguity failure.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import type { JsonLocatorIntent } from '../../../src/locator/types.js';

import '../../../src/locator/injected/index.js';

interface InjectedTestApi {
  resolveCandidate(intent: JsonLocatorIntent, strict: boolean): { count: number };
  getSlotElement(): Element | null;
}

function injected(): InjectedTestApi {
  return (globalThis as unknown as { __yantra: InjectedTestApi }).__yantra;
}

const originalGetRect = Element.prototype.getBoundingClientRect;

/**
 * jsdom performs no layout, so every element reports a zero rect and would read
 * as hidden. Give the named elements a real box and leave the rest at zero.
 */
function makeVisible(...elements: Element[]): void {
  const visible = new Set(elements);
  Element.prototype.getBoundingClientRect = function (this: Element) {
    return visible.has(this)
      ? ({ top: 0, left: 0, width: 100, height: 40, right: 100, bottom: 40, x: 0, y: 0 } as DOMRect)
      : ({ top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0 } as DOMRect);
  };
}

describe('@no-llm injected resolveCandidate visibility preference', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    Element.prototype.getBoundingClientRect = originalGetRect;
  });

  it('narrows to the visible element when a hidden duplicate shares role and name', () => {
    document.body.innerHTML =
      '<button id="mobile">Track</button><button id="desktop">Track</button>';
    const desktop = document.getElementById('desktop')!;
    makeVisible(desktop);

    const result = injected().resolveCandidate(
      { kind: 'role', role: 'button', name: 'Track', exact: true },
      true,
    );

    expect(result.count).toBe(1);
    expect(injected().getSlotElement()).toBe(desktop);
  });

  it('still reports ambiguity when several matches are genuinely visible', () => {
    // The narrowing is a duplicate filter, not a licence to guess.
    document.body.innerHTML = '<button>Track</button><button>Track</button>';
    const [first, second] = Array.from(document.querySelectorAll('button'));
    makeVisible(first!, second!);

    const result = injected().resolveCandidate(
      { kind: 'role', role: 'button', name: 'Track', exact: true },
      true,
    );

    expect(result.count).toBe(2);
  });

  it('returns the hidden matches unchanged when nothing visible matches', () => {
    // A preference, not a filter: `wait_for: hidden` and `detached` must still
    // be able to observe the element they are waiting on.
    document.body.innerHTML = '<button id="only">Track</button>';
    makeVisible(); // nothing visible

    const result = injected().resolveCandidate(
      { kind: 'role', role: 'button', name: 'Track', exact: true },
      true,
    );

    expect(result.count).toBe(1);
    expect(injected().getSlotElement()).toBe(document.getElementById('only'));
  });

  it('applies the same narrowing to a CSS candidate', () => {
    document.body.innerHTML = '<div class="row" id="a"></div><div class="row" id="b"></div>';
    const b = document.getElementById('b')!;
    makeVisible(b);

    const result = injected().resolveCandidate({ kind: 'css', selector: '.row' }, true);

    expect(result.count).toBe(1);
    expect(injected().getSlotElement()).toBe(b);
  });

  it('reports zero when nothing matches at all', () => {
    document.body.innerHTML = '<button>Other</button>';

    const result = injected().resolveCandidate(
      { kind: 'role', role: 'button', name: 'Track', exact: true },
      true,
    );

    expect(result.count).toBe(0);
    expect(injected().getSlotElement()).toBeNull();
  });

  it('leaves a single match untouched regardless of visibility', () => {
    document.body.innerHTML = '<button id="one">Track</button>';
    makeVisible();

    expect(
      injected().resolveCandidate(
        { kind: 'role', role: 'button', name: 'Track', exact: true },
        true,
      ).count,
    ).toBe(1);
  });
});
