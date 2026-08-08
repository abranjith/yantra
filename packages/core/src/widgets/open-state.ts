import { widgetFailure, type WidgetFailure, type WidgetPort, type WidgetTarget } from './types.js';

/** Maximum time allowed for a trigger to reveal its controlled popup. */
export const OPEN_WAIT_MS = 3_000;
/** Polling cadence while waiting for a popup state transition. */
export const POLL_MS = 100;

/** Serializable location of a widget container in the live DOM. */
export interface WidgetContainer {
  readonly path: readonly number[];
}

/** Successful open-state transition. */
export interface OpenWidgetState {
  readonly ok: true;
  readonly container: WidgetContainer;
  readonly wasOpen: boolean;
}

/**
 * Resolve a controlled or adjacent widget container without changing state.
 *
 * `allowUnlinked` enables a last-resort scan for a popup the trigger does not
 * declare. It is deliberately opt-in and off by default, because detection is
 * one of the callers: a driver asking "is this a date control?" must never be
 * told yes on the strength of some unrelated dialog that happens to be open
 * elsewhere on the page. Only a driver already committed to operating this
 * target may reach for it.
 */
export async function resolveContainer(
  port: WidgetPort,
  target: WidgetTarget,
  { allowUnlinked = false }: { readonly allowUnlinked?: boolean } = {},
): Promise<WidgetContainer | null> {
  const path = await port.evaluateOn(
    target.ref,
    (element, unlinked) => {
      const visible = (candidate: Element): boolean => {
        if (!(candidate instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(candidate);
        const rect = candidate.getBoundingClientRect();
        // Both dimensions, not either: an empty block-level placeholder stretches
        // to its parent's width at zero height, and `width > 0` alone waves it
        // through as a rendered popup. The child-count clause is what keeps this
        // usable where there is no layout engine at all.
        return (
          !candidate.hidden &&
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          ((rect.width > 0 && rect.height > 0) || candidate.childElementCount > 0)
        );
      };
      const toPath = (candidate: Element): number[] => {
        const result: number[] = [];
        let current: Element | null = candidate;
        while (current && current !== document.documentElement) {
          const parent: Element | null = current.parentElement;
          if (!parent) return [];
          result.unshift(Array.prototype.indexOf.call(parent.children, current));
          current = parent;
        }
        return result;
      };
      const byId = (attribute: 'aria-controls' | 'aria-owns'): Element | null => {
        const ids = element.getAttribute(attribute)?.trim().split(/\s+/) ?? [];
        for (const id of ids) {
          const found = document.getElementById(id);
          if (found) return found;
        }
        return null;
      };
      const POPUP_SELECTOR =
        '[role="dialog"],[role="listbox"],[role="menu"],[role="grid"],dialog,[aria-modal="true"]';
      // A declared target still has to look like a popup. Tabbed pickers commonly
      // point `aria-controls` at an empty tabpanel placeholder and render the
      // panel's content as a sibling, so an element with nothing inside it is a
      // label for the popup, not the popup — keep looking.
      const controlled = byId('aria-controls') ?? byId('aria-owns');
      if (controlled && controlled.childElementCount > 0) return toPath(controlled);
      if (element.hasAttribute('aria-haspopup')) {
        let sibling = element.nextElementSibling;
        while (sibling) {
          if (visible(sibling) && sibling.matches(POPUP_SELECTOR)) return toPath(sibling);
          sibling = sibling.nextElementSibling;
        }
      }
      // Last resort: an unambiguously open popup. A trigger that names its
      // container declaratively never reaches here; this covers the common case
      // of a popup that is neither referenced by id nor a sibling of its
      // trigger. "Exactly one" is the safety property — with two candidates we
      // cannot say which belongs to this trigger, so we claim neither.
      if (!unlinked) return null;
      const open = Array.from(document.querySelectorAll(POPUP_SELECTOR)).filter(
        (candidate) => visible(candidate) && !candidate.contains(element),
      );
      const outermost = open.filter(
        (candidate) => !open.some((other) => other !== candidate && other.contains(candidate)),
      );
      return outermost.length === 1 ? toPath(outermost[0]!) : null;
    },
    allowUnlinked,
  );
  return path && path.length > 0 ? { path } : null;
}

/**
 * Report whether a resolved widget container is currently open.
 *
 * `aria-expanded` is treated as a positive signal only. A great many triggers
 * ship the attribute hard-coded to `"false"`, or update it on a different node
 * than the one the observation resolved, and believing that over a container
 * that is plainly rendered is worse than having no signal at all: the driver
 * concludes "closed", clicks to open, and thereby *closes* the widget it was
 * asked to operate. What is on screen wins over what the trigger claims.
 */
export async function isOpen(
  port: WidgetPort,
  target: WidgetTarget,
  container: WidgetContainer,
): Promise<boolean> {
  const expanded = await port.evaluateOn(target.ref, (element) =>
    element.getAttribute('aria-expanded'),
  );
  if (expanded === 'true') return true;
  return port.evaluate((path) => {
    let current: Element | null = document.documentElement;
    for (const index of path) current = current?.children.item(index) ?? null;
    if (!(current instanceof HTMLElement)) return false;
    const style = window.getComputedStyle(current);
    const rect = current.getBoundingClientRect();
    return (
      !current.hidden &&
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      ((rect.width > 0 && rect.height > 0) || current.childElementCount > 0)
    );
  }, container.path);
}

/**
 * Open a widget only when closed, including a before/after DOM-diff fallback.
 *
 * The DOM diff can only recognise a container that *appears*, so on its own it
 * is blind to the case that matters most: the widget was already open, the
 * trigger click shut it, and nothing new ever arrives. That is detected here as
 * a container that vanished, and undone with a single re-opening click.
 */
export async function openIfClosed(
  port: WidgetPort,
  target: WidgetTarget,
): Promise<OpenWidgetState | WidgetFailure> {
  const existing = await resolveContainer(port, target, { allowUnlinked: true });
  if (existing && (await isOpen(port, target, existing))) {
    return { ok: true, container: existing, wasOpen: true };
  }

  const deadline = port.now() + OPEN_WAIT_MS;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = (await visibleContainerPaths(port)).map((path) => path.join('.'));
    const beforeSet = new Set(before);
    await port.click(target.ref);
    let closedSomething = false;
    do {
      const controlled = await resolveContainer(port, target, { allowUnlinked: true });
      if (controlled && (await isOpen(port, target, controlled))) {
        // A second attempt only happens after our own click closed the widget,
        // so reaching here means it was open when the driver was called.
        return { ok: true, container: controlled, wasOpen: attempt > 0 };
      }
      const after = await visibleContainerPaths(port);
      const appeared = after.find((path) => !beforeSet.has(path.join('.')));
      if (appeared) return { ok: true, container: { path: appeared }, wasOpen: attempt > 0 };
      const afterSet = new Set(after.map((path) => path.join('.')));
      if (before.some((path) => !afterSet.has(path))) {
        closedSomething = true;
        break;
      }
      if (port.now() >= deadline) break;
      await sleep(POLL_MS);
    } while (port.now() <= deadline);
    if (!closedSomething || port.now() >= deadline) break;
  }

  return widgetFailure(
    'WIDGET_DID_NOT_OPEN',
    `The widget "${target.name}" did not expose a visible container within ${OPEN_WAIT_MS} ms.`,
    { waitMs: OPEN_WAIT_MS },
  );
}

/** Restore the entry state after a driver finishes. */
export async function restore(
  port: WidgetPort,
  target: WidgetTarget,
  wasOpen: boolean,
): Promise<void> {
  if (wasOpen) return;
  const container = await resolveContainer(port, target, { allowUnlinked: true });
  if (!container || !(await isOpen(port, target, container))) return;
  await port.press('Escape');
  await sleep(POLL_MS);
  if (await isOpen(port, target, container)) await port.click(target.ref);
}

async function visibleContainerPaths(port: WidgetPort): Promise<readonly (readonly number[])[]> {
  return port.evaluate(() => {
    const selector =
      '[role="dialog"],[role="listbox"],[role="menu"],[role="grid"],dialog,[aria-modal="true"]';
    const toPath = (candidate: Element): number[] => {
      const result: number[] = [];
      let current: Element | null = candidate;
      while (current && current !== document.documentElement) {
        const parent: Element | null = current.parentElement;
        if (!parent) return [];
        result.unshift(Array.prototype.indexOf.call(parent.children, current));
        current = parent;
      }
      return result;
    };
    return Array.from(document.querySelectorAll(selector))
      .filter((candidate): candidate is HTMLElement => candidate instanceof HTMLElement)
      .filter((candidate) => {
        const style = window.getComputedStyle(candidate);
        const rect = candidate.getBoundingClientRect();
        return (
          !candidate.hidden &&
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          ((rect.width > 0 && rect.height > 0) || candidate.childElementCount > 0)
        );
      })
      .map(toPath)
      .filter((path) => path.length > 0);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
