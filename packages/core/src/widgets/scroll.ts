/// <reference lib="dom" />

import type { ScrollFrame } from './types.js';

/**
 * Advance a container's own scrollable region by one step, in page context.
 *
 * One implementation shared by every `WidgetPort`, passed to each port's
 * `evaluate`. Self-contained because Puppeteer serializes only the function
 * body — a helper imported from module scope would not survive the crossing.
 *
 * The region is the nearest element with a computed `overflowY` of `auto` or
 * `scroll`, searched from the container's own subtree outward to the container
 * itself, preferring one that actually overflows when several qualify. The
 * **longhand** is read deliberately: the `overflow` shorthand computes to `''`
 * on a page that set only `overflow-y`, so reading it would find no region on
 * exactly the lists this exists for.
 *
 * `window`, `document.scrollingElement`, `document.body`, and
 * `document.documentElement` are excluded by construction. Scrolling the window
 * would move the whole page under an agent that asked only for a list to be
 * advanced — the container owns its region, and nothing else.
 *
 * Returns `null` when no such region exists, which is a normal named outcome.
 */
export function scrollContainerInPage(
  path: readonly number[],
  step: number | null,
): ScrollFrame | null {
  /** Overlap kept between windows so a row straddling the fold is not skipped. */
  const overlapPx = 40;
  let current: Element | null = document.documentElement;
  for (const index of path) current = current?.children.item(index) ?? null;
  if (!(current instanceof HTMLElement)) return null;

  const excluded = new Set<Element | null>([
    document.scrollingElement,
    document.body,
    document.documentElement,
  ]);
  const scrollable: HTMLElement[] = [];
  for (const candidate of [...Array.from(current.querySelectorAll('*')), current]) {
    if (!(candidate instanceof HTMLElement) || excluded.has(candidate)) continue;
    const overflowY = window.getComputedStyle(candidate).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll') scrollable.push(candidate);
  }
  if (scrollable.length === 0) return null;
  const region =
    scrollable.find((candidate) => candidate.scrollHeight > candidate.clientHeight) ??
    scrollable[0]!;

  const before = region.scrollTop;
  // `scrollTop` assignment, never a wheel dispatch: a wheel event targets
  // whatever sits under the cursor and can reach the window.
  region.scrollTop = before + (step ?? Math.max(1, region.clientHeight - overlapPx));
  // A renderer keyed to the event re-mounts promptly; one keyed to `scrollTop`
  // is idempotent under the extra event a real browser also fires.
  region.dispatchEvent(new Event('scroll', { bubbles: false }));
  const after = region.scrollTop;
  return {
    scrollTop: after,
    scrollHeight: region.scrollHeight,
    clientHeight: region.clientHeight,
    moved: after !== before,
    atEnd: after + region.clientHeight >= region.scrollHeight - 1,
  };
}
