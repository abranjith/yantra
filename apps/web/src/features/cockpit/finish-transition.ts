/**
 * The finish (FEAT-067 TASK-015): when a run the user watched ends, the
 * cockpit becomes its result page through a View Transition, the goal and
 * the outcome morphing into place (shared `view-transition-name`s).
 *
 * - Under reduced motion or Solid surfaces it navigates without animation;
 *   without the View Transitions API, it simply navigates.
 * - It never navigates away while the user is working in the Command panel
 *   or a dialog: it holds, and the cockpit offers "View result" instead.
 * - The transition moves focus nowhere. Only when the element that had focus
 *   is gone after the navigation does focus go to the result page's heading,
 *   so focus is never lost to `body`. Focus that was on `body` stays there.
 */

/** Where focus lands when the focused cockpit element is removed. */
export const RESULT_HEADING_SELECTOR = '[data-focus-target="run-heading"]';

/** The slice of `document` the finish uses (tests pass a stand-in). */
export interface FinishDocument {
  readonly activeElement: Element | null;
  readonly body: HTMLElement;
  readonly documentElement: HTMLElement;
  contains(node: Node | null): boolean;
  querySelector(selector: string): Element | null;
  startViewTransition?: (update: () => Promise<void> | void) => {
    readonly finished: Promise<void>;
  };
}

export interface FinishOptions {
  readonly navigate: () => Promise<void> | void;
  readonly reducedMotion: boolean;
  readonly doc?: FinishDocument;
  /** Waits for the result heading after navigation (tests step it). */
  readonly waitForHeading?: (doc: FinishDocument) => Promise<HTMLElement | null>;
}

/** Whether the user is working where an automatic navigation would interrupt them. */
export function shouldHoldFinish(doc: FinishDocument): boolean {
  const active = doc.activeElement;
  if (active === null || active === doc.body) return false;
  return active.closest('[data-panel="command"], [role="dialog"], [role="alertdialog"]') !== null;
}

/** Whether Solid surfaces are in force (no glass, no morphing). */
function solid(doc: FinishDocument): boolean {
  return (
    doc.documentElement.closest('[data-surfaces="solid"]') !== null ||
    doc.body.closest('[data-surfaces="solid"]') !== null
  );
}

/** Polls a few frames for the result heading (it renders once the result loads). */
async function defaultWaitForHeading(doc: FinishDocument): Promise<HTMLElement | null> {
  for (let frame = 0; frame < 120; frame += 1) {
    const heading = doc.querySelector(RESULT_HEADING_SELECTOR);
    if (heading instanceof HTMLElement) return heading;
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        resolve();
      });
    });
  }
  return null;
}

/** Runs the finish; resolves `held` when it did not navigate. See the module comment. */
export async function finishTransition({
  navigate,
  reducedMotion,
  doc = document,
  waitForHeading = defaultWaitForHeading,
}: FinishOptions): Promise<'navigated' | 'held'> {
  if (shouldHoldFinish(doc)) return 'held';
  const focused =
    doc.activeElement !== null && doc.activeElement !== doc.body ? doc.activeElement : null;
  const update = async (): Promise<void> => {
    await navigate();
  };
  if (!reducedMotion && !solid(doc) && typeof doc.startViewTransition === 'function') {
    await doc.startViewTransition(update).finished.catch(() => undefined);
  } else {
    await update();
  }
  if (focused !== null && !doc.contains(focused)) {
    const heading = await waitForHeading(doc);
    heading?.focus();
  }
  return 'navigated';
}
