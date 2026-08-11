import type { WidgetPort } from '../widgets/types.js';

/**
 * Escape presses allowed in one dismissal pass.
 *
 * A pass stops early the moment an Escape closes nothing, so this bound only
 * costs anything on a page that really is unwinding a stack of overlays.
 */
export const OVERLAY_DISMISS_ATTEMPTS = 3;
/** Pause after Escape before re-reading which overlays are still open. */
export const OVERLAY_SETTLE_MS = 200;

/** Outcome of one bounded overlay dismissal pass. */
export interface OverlayDismissal {
  /** Overlays that were open on arrival and are now gone. */
  readonly dismissed: number;
  /** Overlays still open after the bounded attempts. */
  readonly remaining: number;
}

/**
 * Close floating overlays the *site* raised, using the one gesture every
 * popup honours.
 *
 * Real booking and travel sites routinely serve a page with its date picker
 * already open, and drop a promo or "change your search" dialog on top of the
 * results. Nothing in the run opened those, and they are not merely cosmetic:
 * the observation is a flat, capped list of interactables, so an open calendar
 * contributes ~170 day cells and the model-visible page becomes *only* the
 * overlay. In run `20260811T025845Z-do-963e62f1` every landing on
 * `kayak.com/hotels` returned 50 interactables of which 50 were day cells; the
 * destination field and the search button were invisible, and
 * `browser_fill_element` answered `FORM_FIELD_NOT_FOUND` for "Destination"
 * while listing "August 1, 2026 … (+162 more)" as what was available.
 *
 * Ownership is what makes this safe to do automatically, and it is why this
 * runs after a navigation and nowhere else. The caller asked for a page, not
 * for a dialog, so anything floating over the document it just loaded is
 * unowned. An overlay that appears *because* the agent clicked something is
 * the agent's own — it may well be the thing it wants to operate — and is
 * never touched here. The fill engine likewise owns and releases its own
 * widgets (see `fill/dismiss.ts`).
 *
 * Best-effort by construction: a stubborn overlay (a consent wall that ignores
 * Escape) costs one keypress and is then reported as `remaining` rather than
 * fought.
 */
export async function dismissSiteOverlays(
  port: Pick<WidgetPort, 'evaluate' | 'press'>,
): Promise<OverlayDismissal> {
  let open = await openOverlayPaths(port);
  const initial = open.length;
  if (initial === 0) return { dismissed: 0, remaining: 0 };
  for (let attempt = 0; attempt < OVERLAY_DISMISS_ATTEMPTS && open.length > 0; attempt += 1) {
    await port.press('Escape');
    await sleep(OVERLAY_SETTLE_MS);
    const next = await openOverlayPaths(port);
    const progressed = next.length < open.length;
    open = next;
    // An Escape that closed nothing will not close anything on a second try,
    // and every extra press is a keystroke delivered to a page that is already
    // showing what it means to show.
    if (!progressed) break;
  }
  return { dismissed: Math.max(0, initial - open.length), remaining: open.length };
}

/**
 * Locate the site-raised overlays currently covering the page.
 *
 * Three conditions, each earning its place:
 *
 * - **Rendered.** Popup markup is usually present and merely hidden; a display
 *   or visibility check is what separates open from mounted.
 * - **Floating.** A popup is out of normal flow — itself, or via a wrapper a
 *   few levels up. This is the clause that keeps a results table marked up as
 *   `role="grid"` (statically positioned page content) from being mistaken for
 *   a calendar popover and Escaped on every load.
 * - **Operable, unless modal.** A floating container with nothing to interact
 *   with is decoration. `aria-modal` and an open `<dialog>` say outright that
 *   they are blocking the page, so they are taken at their word.
 *
 * Only the outermost of a nested pair is reported: closing a modal takes its
 * inner listbox with it, and counting both would report progress twice.
 */
function openOverlayPaths(
  port: Pick<WidgetPort, 'evaluate'>,
): Promise<readonly (readonly number[])[]> {
  return port.evaluate(() => {
    const OVERLAY_SELECTOR =
      'dialog,[role="dialog"],[role="alertdialog"],[aria-modal="true"],' +
      '[role="listbox"],[role="menu"],[role="grid"],[role="tree"]';
    const INTERACTIVE_SELECTOR =
      'button,a[href],input,select,textarea,[role="button"],[role="link"],' +
      '[role="option"],[role="menuitem"],[role="checkbox"],[role="radio"],[role="gridcell"]';
    /** How far above the container a positioning wrapper may sit. */
    const FLOAT_ANCESTRY = 4;

    const rendered = (element: HTMLElement): boolean => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        !element.hidden &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        style.opacity !== '0' &&
        rect.width > 0 &&
        rect.height > 0
      );
    };
    const floating = (element: HTMLElement): boolean => {
      let current: HTMLElement | null = element;
      for (let depth = 0; current && depth < FLOAT_ANCESTRY; depth += 1) {
        if (current === document.body) return false;
        const position = window.getComputedStyle(current).position;
        if (position === 'fixed' || position === 'absolute') return true;
        current = current.parentElement;
      }
      return false;
    };
    const modal = (element: HTMLElement): boolean =>
      element.getAttribute('aria-modal') === 'true' ||
      (element.tagName === 'DIALOG' && element.hasAttribute('open'));
    const toPath = (element: Element): number[] => {
      const result: number[] = [];
      let current: Element | null = element;
      while (current && current !== document.documentElement) {
        const parent: Element | null = current.parentElement;
        if (!parent) return [];
        result.unshift(Array.prototype.indexOf.call(parent.children, current));
        current = parent;
      }
      return result;
    };

    const found = Array.from(document.querySelectorAll(OVERLAY_SELECTOR))
      .filter((element): element is HTMLElement => element instanceof HTMLElement)
      .filter((element) => rendered(element))
      .filter((element) => modal(element) || floating(element))
      .filter((element) => modal(element) || element.querySelector(INTERACTIVE_SELECTOR) !== null);
    return found
      .filter((element) => !found.some((other) => other !== element && other.contains(element)))
      .map(toPath)
      .filter((path) => path.length > 0);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
