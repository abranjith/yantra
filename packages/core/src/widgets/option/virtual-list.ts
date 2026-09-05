import {
  MAX_RANKED_OFFERED,
  normalizeText,
  rankAgainstRequested,
  type ChoiceSubstitution,
} from '../../interaction/index.js';
import { readWhenStable } from '../../interaction/settle.js';
import type { WidgetContainer } from '../open-state.js';
import type { WidgetBudget, WidgetPort } from '../types.js';

import { collectChoices, type WidgetCandidate } from './candidates.js';

/**
 * Distinct option identities one scan will remember.
 *
 * Bounds the memory a pathological list can make the engine hold. Well above
 * any list a person is expected to read through, and far below "unbounded".
 */
export const MAX_TRACKED_OPTION_IDENTITIES = 500;

/** How long to let a re-render settle before reading the next window. */
const WINDOW_SETTLE_POLL_MS = 30;
const WINDOW_SETTLE_QUIET_POLLS = 2;

/**
 * Why a virtual scan stopped.
 *
 * A closed set with no "just finished" arm: every exit is named, because an
 * unnamed exit is an unbounded loop waiting to happen.
 */
export type VirtualListStop =
  | 'matched'
  | 'not-scrollable'
  | 'reached-end'
  | 'no-new-options'
  | 'scroll-position-unchanged'
  | 'step-cap'
  | 'budget';

/** Bounded progress evidence for a scrollable option container. */
export interface VirtualListCursor {
  /** Mounted windows examined; always at least 1 — the first costs no scroll. */
  readonly windows: number;
  /** Scroll actions charged, also counted against `WidgetBudget.maxActions`. */
  readonly scrolls: number;
  /** Deduplicated content-derived identities seen across every window. */
  readonly seen: ReadonlySet<string>;
  /** Display labels in first-seen order, capped like every other offered set. */
  readonly offered: readonly string[];
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly atEnd: boolean;
  readonly stoppedBecause: VirtualListStop;
}

/** The scan's answer: the matching candidate, or the evidence there was none. */
export type VirtualListScan =
  | {
      readonly kind: 'match';
      readonly candidate: WidgetCandidate;
      readonly substitution?: ChoiceSubstitution;
      readonly cursor: VirtualListCursor;
    }
  | {
      readonly kind: 'ambiguous';
      readonly offered: readonly string[];
      readonly cursor: VirtualListCursor;
    }
  | { readonly kind: 'none'; readonly cursor: VirtualListCursor };

/**
 * The identity two mounted windows agree on for "the same option".
 *
 * Content-derived, and that is a requirement rather than a preference: a
 * virtual list recycles its DOM nodes, so a node- or path-derived identity
 * reports the same recycled `<li>` as a new option forever and no-progress can
 * never be detected. Shares `normalizeText` with ranking and commit
 * verification so dedup and matching cannot drift into two ideas of sameness.
 */
export function optionIdentity(candidate: WidgetCandidate): string {
  return `${normalizeText(candidate.name)}\u0000${candidate.role}`;
}

/**
 * Walk a virtualized option list window by window, bounded and deduplicated.
 *
 * Returns as soon as a window answers the request, so the candidate is always
 * clicked from the window it was found in — a later scroll recycles the nodes,
 * and clicking from a stale snapshot would press whatever row now occupies that
 * position.
 *
 * Termination is **identity-first**. `reached-end` is corroborating evidence
 * recorded alongside, never the sole stop: `scrollHeight`/`clientHeight` are
 * `0` in any environment without a layout engine, which makes `atEnd`
 * vacuously true there and would end the scan before it began.
 */
export async function scanVirtualOptions(
  port: WidgetPort,
  container: WidgetContainer,
  requested: string,
  budget: WidgetBudget,
  spent: {
    readonly actions: number;
    /**
     * The window the caller has already read.
     *
     * Passed in rather than re-read: the driver ranks the initial window before
     * deciding it needs to scroll at all, and reading it twice would charge the
     * page for a diagnostic the caller had already paid for.
     */
    readonly firstWindow?: readonly WidgetCandidate[];
  } = { actions: 0 },
): Promise<VirtualListScan> {
  const seen = new Set<string>();
  const offered: string[] = [];
  let windows = 0;
  let scrolls = 0;
  let scrollTop = 0;
  let scrollHeight = 0;
  let clientHeight = 0;
  let atEnd = false;

  const cursor = (stoppedBecause: VirtualListStop): VirtualListCursor => ({
    windows,
    scrolls,
    seen,
    offered: [...offered],
    scrollTop,
    scrollHeight,
    clientHeight,
    atEnd,
    stoppedBecause,
  });

  // Every window is read exactly once: the first comes from the caller when it
  // has one, and every later one is the settled result of the scroll that
  // revealed it.
  let window = spent.firstWindow ?? (await collectChoices(port, container)).choices;

  for (;;) {
    windows += 1;

    const ranked = rankAgainstRequested(window, requested, container.path);
    if (ranked.kind === 'match') {
      return {
        kind: 'match',
        candidate: ranked.candidate,
        cursor: cursor('matched'),
        ...(ranked.substitution ? { substitution: ranked.substitution } : {}),
      };
    }
    if (ranked.kind === 'ambiguous') {
      // An ambiguity is an answer, not an absence: scrolling on would collect
      // more rows to be ambiguous about while the caller still cannot choose.
      return { kind: 'ambiguous', offered: ranked.offered, cursor: cursor('matched') };
    }

    let fresh = 0;
    for (const candidate of window) {
      if (candidate.disabled) continue;
      const identity = optionIdentity(candidate);
      if (seen.has(identity)) continue;
      if (seen.size < MAX_TRACKED_OPTION_IDENTITIES) seen.add(identity);
      fresh += 1;
      if (offered.length < MAX_RANKED_OFFERED) offered.push(candidate.name);
    }

    // The window contributed nothing the previous ones had not: the list is
    // either exhausted or recycling the same rows, and either way scrolling
    // again spends an action to learn nothing.
    if (windows > 1 && fresh === 0) return { kind: 'none', cursor: cursor('no-new-options') };
    if (scrolls >= budget.maxScrollSteps) return { kind: 'none', cursor: cursor('step-cap') };
    if (port.now() > budget.deadlineMs || spent.actions + scrolls + 1 > budget.maxActions) {
      return { kind: 'none', cursor: cursor('budget') };
    }

    const frame = await port.scrollContainer(container);
    if (!frame) return { kind: 'none', cursor: cursor('not-scrollable') };
    scrolls += 1;
    scrollTop = frame.scrollTop;
    scrollHeight = frame.scrollHeight;
    clientHeight = frame.clientHeight;
    atEnd = frame.atEnd;
    if (!frame.moved) return { kind: 'none', cursor: cursor('scroll-position-unchanged') };

    // Wait for the re-render rather than sleeping a fixed amount: a renderer
    // that mounts its next window on an animation frame and one that mounts it
    // synchronously both settle here, and neither is charged for the other.
    window = (
      await readWhenStable(
        () => collectChoices(port, container).then((choiceSet) => choiceSet.choices),
        (candidates) => candidates.map((candidate) => candidate.name).join('\u0000'),
        {
          quietPolls: WINDOW_SETTLE_QUIET_POLLS,
          pollMs: WINDOW_SETTLE_POLL_MS,
          deadlineMs: budget.deadlineMs,
          now: () => port.now(),
        },
      )
    ).value;
  }
}
