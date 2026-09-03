import type { ElementHandle, Page as PuppeteerPage } from 'puppeteer-core';

import type { AttemptRecord } from '../interaction/types.js';

import {
  classifyObstruction,
  ElementObstructedError,
  OVERLAY_ANCESTRY,
  type ClearanceResult,
  type ClearanceSkipReason,
  type Obstruction,
  type ObstructionCandidate,
  type OverlayNodeSummary,
} from './obstruction.js';

/**
 * Brief hover dwell before a pointer action, allowing real hover states and
 * menus to react before the trusted click/focus events arrive.
 */
export const POINTER_SETTLE_MS = 75;

/** A viewport coordinate. The one value that is tested and then dispatched. */
export interface PointerPoint {
  readonly x: number;
  readonly y: number;
}

/** What the in-page probe saw at the tested coordinate. */
export type HitTestResult =
  | { readonly reachable: true }
  | { readonly reachable: false; readonly chain: readonly OverlayNodeSummary[] };

/**
 * Ask the page what is topmost at one viewport coordinate.
 *
 * Serialized into the page by `handle.evaluate`, so it must reference nothing
 * from module scope — every helper is defined inline and only DOM globals are
 * used. It is exported so JSDOM tests can call it directly against a document
 * whose `elementFromPoint` they control.
 *
 * Reachability is decided by walking the **composed** ancestry upward from the
 * hit node: the point is reachable when the target is that node, an ancestor of
 * it, or its shadow host. Anything else is an interception, and the chain of
 * summaries handed back is what {@link classifyObstruction} names.
 */
export function hitTestAtPoint(
  element: Element,
  x: number,
  y: number,
  depth: number,
): HitTestResult {
  // Always the top-level document: a shadow root's own `elementFromPoint` is
  // scoped to its tree and would miss the overlay that is actually on top.
  let hit: Element | null = element.ownerDocument.elementFromPoint(x, y);
  // Descend open shadow roots: `elementFromPoint` stops at the host, and the
  // node that actually receives the pointer event lives inside.
  while (hit?.shadowRoot) {
    const inner: Element | null = hit.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === hit) break;
    hit = inner;
  }
  // Nothing at the coordinate is not evidence of an overlay; there is no
  // container to name and no dismissal to offer. Let the existing stale/hidden
  // recovery own that case rather than inventing an obstruction with no identity.
  if (!hit) return { reachable: true };

  const composedParent = (node: Element): Element | null => {
    const parent = node.parentElement;
    if (parent) return parent;
    const nodeRoot = node.getRootNode() as { readonly host?: Element };
    return nodeRoot?.host ?? null;
  };

  for (let node: Element | null = hit; node; node = composedParent(node)) {
    if (node === element) return { reachable: true };
  }

  const chain: OverlayNodeSummary[] = [];
  let node: Element | null = hit;
  for (let level = 0; node && level < depth; level += 1) {
    const style = node.ownerDocument.defaultView?.getComputedStyle(node);
    const explicitRole = node.getAttribute('role');
    const tag = node.tagName.toLowerCase();
    const labelledBy = node.getAttribute('aria-labelledby');
    const labelled = labelledBy
      ? labelledBy
          .split(/\s+/)
          .map((id) => node?.ownerDocument.getElementById(id)?.textContent ?? '')
          .join(' ')
      : '';
    const name =
      node.getAttribute('aria-label') ??
      (labelled.trim().length > 0 ? labelled : null) ??
      node.getAttribute('title') ??
      node.textContent ??
      '';
    chain.push({
      role: explicitRole && explicitRole.length > 0 ? explicitRole : tag,
      name,
      ariaBusy: node.getAttribute('aria-busy') === 'true',
      modal:
        node.getAttribute('aria-modal') === 'true' ||
        (tag === 'dialog' && node.hasAttribute('open')),
      position: style ? style.position : 'static',
    });
    node = composedParent(node);
  }
  return { reachable: false, chain };
}

/**
 * Re-walk to the obstruction root so the caller holds a live handle for it.
 *
 * Runs only after interception is detected. Repeating the descent rather than
 * returning a handle from the probe keeps the probe — the check every pointer
 * dispatch pays for — a single plain-data round trip.
 */
export function obstructionRootAtPoint(x: number, y: number, levels: number): Element | null {
  let hit: Element | null = document.elementFromPoint(x, y);
  while (hit?.shadowRoot) {
    const inner: Element | null = hit.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === hit) break;
    hit = inner;
  }
  for (let level = 0; hit && level < levels; level += 1) {
    const parent: Element | null =
      hit.parentElement ?? (hit.getRootNode() as { readonly host?: Element }).host ?? null;
    if (!parent) return hit;
    hit = parent;
  }
  return hit;
}

/** Candidates minted for one obstruction, with the pressable subset marked. */
export interface MintedCandidates {
  readonly candidates: readonly ObstructionCandidate[];
  readonly truncated: boolean;
}

/**
 * Everything the pre-flight needs from the controller.
 *
 * Injected rather than imported so this module stays free of the controller and
 * of any import cycle, and so each collaborator is individually stubbable.
 */
export interface PointerPreflightDeps {
  readonly page: PuppeteerPage;
  readonly handle: ElementHandle<Element>;
  /**
   * Mint dismiss candidates from the obstructing subtree.
   *
   * Called **only** after interception is detected: this is the one bounded
   * obstruction-scoped page read, and the clear path must not pay for it.
   */
  readonly mintCandidates: (point: PointerPoint, rootLevels: number) => Promise<MintedCandidates>;
  /** Whether this top-level tool call has already spent its one clearance. */
  readonly clearanceSpent: () => boolean;
  /** Mark the allowance spent. Called **before** the press, never after. */
  readonly spendClearance: () => void;
  /** Dispatch a real pointer press on one minted candidate ref. */
  readonly pressCandidate: (ref: string) => Promise<void>;
  /** The existing page settler; a clearance waits the way every action waits. */
  readonly settle: () => Promise<void>;
  readonly now: () => number;
}

/** A pointer target that has been tested, plus what the attempt cost. */
export interface PreparedPointerTarget {
  readonly point: PointerPoint;
  /** One `clear-obstruction` record when a clearance ran, else empty. */
  readonly attempted: readonly AttemptRecord[];
}

/**
 * Scroll, settle, resolve the exact click point, and prove it is reachable.
 *
 * The sequence is deliberately the existing one — `hover()` (which is how
 * Puppeteer scrolls a target into view) then a settle dwell — with the hit test
 * added **after** it, at the coordinate Puppeteer itself would use. Testing
 * before the scroll is what the below-fold regression forbids, and testing a
 * centre point is what clipped and off-centre quads defeat.
 *
 * @throws {ElementObstructedError} when the point belongs to something else and
 *   the one allowed clearance did not free it.
 */
export async function preparePointerTarget(
  deps: PointerPreflightDeps,
): Promise<PreparedPointerTarget> {
  await deps.handle.hover();
  await sleep(POINTER_SETTLE_MS);
  const raw = await deps.handle.clickablePoint();
  const point: PointerPoint = { x: raw.x, y: raw.y };

  const probe = await hitTest(deps.handle, point);
  if (probe.reachable) return { point, attempted: [] };

  const classified = classifyObstruction(probe.chain);
  const minted =
    classified.kind === 'busy-indicator'
      ? { candidates: [] as readonly ObstructionCandidate[], truncated: false }
      : await deps.mintCandidates(point, classified.rootIndex);

  const eligible = minted.candidates.find((candidate) => candidate.autoClearable);
  const skipped: ClearanceSkipReason | null =
    classified.kind === 'busy-indicator'
      ? 'never-dismissed-kind'
      : deps.clearanceSpent()
        ? 'already-spent-this-call'
        : eligible === undefined
          ? 'no-eligible-candidate'
          : null;

  if (skipped !== null) {
    throw new ElementObstructedError({
      kind: classified.kind,
      identity: classified.identity,
      point,
      clearanceAttempted: false,
      clearanceSkipped: skipped,
      clearanceResult: null,
      candidates: minted.candidates,
      candidatesTruncated: minted.truncated,
    });
  }

  // Spend the allowance BEFORE acting, so a throw inside the press cannot buy a
  // second attempt. There is no recursion here by design: if the dismiss control
  // is itself covered, clearance simply fails — a chain of clearances is the
  // loop this bound exists to prevent.
  deps.spendClearance();
  const startedAt = deps.now();
  let pressError: string | null = null;
  try {
    await deps.pressCandidate(eligible!.ref);
    await deps.settle();
  } catch (error) {
    pressError = error instanceof Error ? error.name : 'ClearanceFailed';
  }

  const recheck = pressError === null ? await hitTest(deps.handle, point) : probe;
  const attempted: readonly AttemptRecord[] = [
    {
      attempt: 1,
      strategy: 'clear-obstruction',
      axis: 'where',
      errorCode: recheck.reachable ? null : 'ELEMENT_OBSTRUCTED',
      elapsedMs: deps.now() - startedAt,
      ...(pressError === null ? {} : { detail: pressError }),
    },
  ];
  if (recheck.reachable) return { point, attempted };

  // Still blocked. Re-classify and re-describe: the agent's next move depends on
  // what is covering the control *now*, not on what was covering it before.
  const after = classifyObstruction(recheck.chain);
  const afterCandidates =
    after.kind === 'busy-indicator'
      ? { candidates: [] as readonly ObstructionCandidate[], truncated: false }
      : await deps.mintCandidates(point, after.rootIndex);
  const result: ClearanceResult =
    after.kind === classified.kind && after.identity.name === classified.identity.name
      ? 'still-obstructed'
      : 'different-obstruction';
  throw new ElementObstructedError({
    kind: after.kind,
    identity: after.identity,
    point,
    clearanceAttempted: true,
    clearanceSkipped: null,
    clearanceResult: result,
    candidates: afterCandidates.candidates,
    candidatesTruncated: afterCandidates.truncated,
  } satisfies Obstruction);
}

/**
 * Dispatch the pointer event at the coordinate that was tested.
 *
 * `handle.click()` is deliberately not used on this path: it recomputes its own
 * point, which would make the tested and dispatched coordinates two different
 * values that merely usually agree.
 */
export async function dispatchAt(
  page: PuppeteerPage,
  point: PointerPoint,
  options: { readonly count?: number; readonly delay?: number } = {},
): Promise<void> {
  await page.mouse.click(point.x, point.y, options);
}

/** Run the composed hit test for one handle at one coordinate. */
async function hitTest(
  handle: ElementHandle<Element>,
  point: PointerPoint,
): Promise<HitTestResult> {
  const evaluate = handle.evaluate.bind(handle) as (
    fn: (element: Element, x: number, y: number, depth: number) => HitTestResult,
    x: number,
    y: number,
    depth: number,
  ) => Promise<HitTestResult>;
  return evaluate(hitTestAtPoint, point.x, point.y, OVERLAY_ANCESTRY);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
