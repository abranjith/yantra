import {
  widgetFailure,
  type WidgetContainer,
  type WidgetFailure,
  type WidgetPort,
  type WidgetTarget,
} from './types.js';

/** Maximum time allowed for a trigger to reveal its controlled popup. */
export const OPEN_WAIT_MS = 3_000;
/** Polling cadence while waiting for a popup state transition. */
export const POLL_MS = 100;
/**
 * Grace given to a container that may still be rendering after some *other*
 * container disappeared in the same click.
 *
 * Real search forms keep more than one popup in play — the destination
 * typeahead's listbox is commonly still up when the date field is driven — so a
 * disappearance immediately after the click usually means "the unrelated popup
 * closed", not "we just shut the widget we were asked to open". Waiting this
 * long before drawing the second conclusion costs a beat in the case that was
 * already slow, and stops the retry from clicking a freshly opened widget shut.
 */
export const REOPEN_GRACE_MS = 750;

export type { WidgetContainer };

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
        const rect = candidate.getBoundingClientRect();
        // Ancestors count. `getComputedStyle` reports an element's own display,
        // not its effective one, so a listbox inside a portal overlay the page
        // just set to `display: none` still reads as rendered — which is how a
        // finished fill came back as "the overlay could not be released".
        // Walking up is also the only visibility signal that survives where
        // there is no layout engine at all.
        for (let node: Element | null = candidate; node; node = node.parentElement) {
          if (!(node instanceof HTMLElement)) break;
          if (node.hidden) return false;
          const style = window.getComputedStyle(node);
          if (style.display === 'none' || style.visibility === 'hidden') return false;
        }
        // Both dimensions, not either: an empty block-level placeholder stretches
        // to its parent's width at zero height, and `width > 0` alone waves it
        // through as a rendered popup. The child-count clause is what keeps this
        // usable where there is no layout engine at all.
        return (rect.width > 0 && rect.height > 0) || candidate.childElementCount > 0;
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
    // Ancestors count — see the note in `resolveContainer`. A page that closes
    // a portal by hiding the whole overlay leaves the listbox inside it with an
    // unchanged computed display of its own.
    for (let node: Element | null = current; node; node = node.parentElement) {
      if (!(node instanceof HTMLElement)) break;
      if (node.hidden) return false;
      const style = window.getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
    }
    const rect = current.getBoundingClientRect();
    return (rect.width > 0 && rect.height > 0) || current.childElementCount > 0;
  }, container.path);
}

/**
 * Open a widget only when closed, including a before/after DOM-diff fallback.
 *
 * The DOM diff can only recognise a container that *appears*, so on its own it
 * is blind to the case that matters most: the widget was already open, the
 * trigger click shut it, and nothing new ever arrives. That is detected here as
 * a container that vanished, and undone with a single re-opening click.
 *
 * Each attempt gets its own {@link OPEN_WAIT_MS} budget. Sharing one deadline
 * meant the retry that exists for the closed-it-ourselves case was, in
 * practice, never taken: the first attempt spent the budget waiting, and the
 * second was skipped for being out of time.
 */
export async function openIfClosed(
  port: WidgetPort,
  target: WidgetTarget,
): Promise<OpenWidgetState | WidgetFailure> {
  const existing = await resolveContainer(port, target, { allowUnlinked: true });
  if (existing && (await isOpen(port, target, existing))) {
    return { ok: true, container: existing, wasOpen: true };
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = (await visibleContainerPaths(port)).map((path) => path.join('.'));
    const beforeSet = new Set(before);
    await port.click(target.ref);
    const deadline = port.now() + OPEN_WAIT_MS;
    let vanishedAt: number | null = null;
    for (;;) {
      // A container the trigger *declares* is its own, whether or not the
      // click changed anything about it.
      const declared = await resolveContainer(port, target);
      if (declared && (await isOpen(port, target, declared))) {
        // A second attempt only happens after our own click closed the widget,
        // so reaching here means it was open when the driver was called.
        return { ok: true, container: declared, wasOpen: attempt > 0 };
      }
      // An undeclared one is only this widget's if the click produced it.
      // Otherwise the scan settles on whatever popup-shaped furniture the page
      // was already showing — a header drawer, a hidden-but-rendered listbox —
      // and hands the driver a container with nothing in it to operate.
      const scanned = await resolveContainer(port, target, { allowUnlinked: true });
      if (
        scanned &&
        !beforeSet.has(scanned.path.join('.')) &&
        (await isOpen(port, target, scanned))
      ) {
        return { ok: true, container: scanned, wasOpen: attempt > 0 };
      }
      const after = await visibleContainerPaths(port);
      const appeared = after.filter((path) => !beforeSet.has(path.join('.')));
      if (appeared.length > 0) {
        return { ok: true, container: openedContainer(appeared), wasOpen: attempt > 0 };
      }
      const afterSet = new Set(after.map((path) => path.join('.')));
      if (vanishedAt === null && before.some((path) => !afterSet.has(path))) {
        vanishedAt = port.now();
      }
      // Something closed and, after a grace period, nothing has opened: the
      // click landed on an already-open widget and shut it. Go around once to
      // put it back. Breaking the instant a container vanished — which is what
      // this used to do — mistook an unrelated popup closing for that, and the
      // retry then clicked the widget this call had just opened closed again.
      if (vanishedAt !== null && port.now() - vanishedAt >= REOPEN_GRACE_MS) break;
      if (port.now() >= deadline) break;
      await sleep(POLL_MS);
    }
    if (vanishedAt === null) break;
  }

  // Last resort: an unambiguously open popup that was there all along. The
  // clicks produced nothing to prefer over it, and a driver handed a container
  // with nothing in it still recovers — its own read widens to the document —
  // whereas a hard failure here ends the fill.
  const standing = await resolveContainer(port, target, { allowUnlinked: true });
  if (standing && (await isOpen(port, target, standing))) {
    return { ok: true, container: standing, wasOpen: true };
  }

  return widgetFailure(
    'WIDGET_DID_NOT_OPEN',
    'picker-did-not-open',
    `The widget "${target.name}" did not expose a visible container within ${OPEN_WAIT_MS} ms.`,
    { waitMs: OPEN_WAIT_MS },
  );
}

/**
 * One container for everything that opened together.
 *
 * Popups arrive as several sibling boxes more often than not — a two-month
 * calendar is two `<table role="grid">` elements, a filter panel is a column of
 * listboxes — and returning the first of them scopes the driver to a fragment
 * of the widget it was asked to operate: the September date is "not offered"
 * because only August was handed over. Everything that appeared in the same
 * click is one popup, so their nearest shared ancestor is the container.
 */
function openedContainer(appeared: readonly (readonly number[])[]): WidgetContainer {
  const [first, ...rest] = appeared;
  let path = [...first!];
  for (const other of rest) {
    let shared = 0;
    while (shared < path.length && shared < other.length && path[shared] === other[shared]) {
      shared += 1;
    }
    path = path.slice(0, shared);
  }
  // "Together" has to mean inside the same box, not merely on the same page:
  // an ancestor at `<body>` or above is the whole document, which is what the
  // drivers' own document-wide fallback is for. Below that, take the first.
  return { path: path.length >= 2 ? path : [...first!] };
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
        for (let node: Element | null = candidate; node; node = node.parentElement) {
          if (!(node instanceof HTMLElement)) break;
          if (node.hidden) return false;
          const style = window.getComputedStyle(node);
          if (style.display === 'none' || style.visibility === 'hidden') return false;
        }
        const rect = candidate.getBoundingClientRect();
        return (rect.width > 0 && rect.height > 0) || candidate.childElementCount > 0;
      })
      .map(toPath)
      .filter((path) => path.length > 0);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
