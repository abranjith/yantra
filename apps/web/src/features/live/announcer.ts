/**
 * What the cockpit says aloud (FEAT-067 TASK-006, plan §9).
 *
 * Screen-reader output has to stay meaningful during a fast run, so only
 * meaningful changes are announced, politely, and never by moving focus:
 *
 * - displayed-state transitions into queued, starting, running, disconnected,
 *   worker not responding, engine stalled, needs review, start outcome
 *   unknown and live view unavailable (and so the recovery back to running);
 * - contract declarations and revisions;
 * - interventions raised (the run waits for you) and resolved;
 * - requirements reaching `met` ("2 of 5 requirements met");
 * - the outcome.
 *
 * Individual tool calls, phases and budget ticks are never announced.
 *
 * {@link createAnnouncementQueue} then speaks at most once every 2 s: within
 * a window, pending announcements collapse to the newest of each category,
 * and the outcome and a wait for you are never dropped.
 */

import { DISPLAYED_WORDS, type DisplayedKind } from './displayed-state.js';

/** What an announcement is about; newer ones replace older ones of the same category. */
export type AnnouncementCategory =
  | 'outcome'
  | 'intervention'
  | 'state'
  | 'contract'
  | 'requirements';

/** One thing to say. */
export interface Announcement {
  readonly category: AnnouncementCategory;
  readonly text: string;
  /** Never dropped by coalescing (outcomes and waits for you). */
  readonly keep: boolean;
}

/** The slice of the cockpit the announcer compares. */
export interface AnnounceView {
  readonly kind: DisplayedKind;
  readonly contract: { readonly revision: number; readonly summary: string } | null;
  readonly interventions: readonly { readonly id: string; readonly summary: string }[];
  readonly met: number;
  readonly total: number;
  /** The outcome words once the run has ended (e.g. `fulfilled`, `interrupted · partial`). */
  readonly outcome: string | null;
}

/** Displayed states whose arrival is announced. */
export const ANNOUNCED_KINDS: ReadonlySet<DisplayedKind> = new Set<DisplayedKind>([
  'queued',
  'starting',
  'running',
  'disconnected',
  'worker_not_responding',
  'engine_stalled',
  'needs_review',
  'start_unknown',
  'live_view_unavailable',
]);

/** Speaking order within one announcement: the most important first. */
const ORDER: readonly AnnouncementCategory[] = [
  'outcome',
  'intervention',
  'state',
  'contract',
  'requirements',
];

/** The announcements for the change from `prev` to `next`; pure. */
export function announcementsFor(prev: AnnounceView | null, next: AnnounceView): Announcement[] {
  const out: Announcement[] = [];
  if (next.outcome !== null && prev?.outcome == null) {
    out.push({ category: 'outcome', text: `Run finished: ${next.outcome}.`, keep: true });
  }
  const before = new Set(prev?.interventions.map((item) => item.id) ?? []);
  const after = new Set(next.interventions.map((item) => item.id));
  const raised = next.interventions.filter((item) => !before.has(item.id));
  const resolved = [...before].filter((id) => !after.has(id));
  if (raised.length > 0) {
    out.push({
      category: 'intervention',
      text: `Waiting for you: ${raised.map((item) => item.summary).join('; ')}.`,
      keep: true,
    });
  } else if (resolved.length > 0 && next.outcome === null) {
    out.push({ category: 'intervention', text: 'Your answer was received.', keep: false });
  }
  if (next.kind !== prev?.kind && ANNOUNCED_KINDS.has(next.kind) && next.outcome === null) {
    out.push({
      category: 'state',
      text: `Run status: ${DISPLAYED_WORDS[next.kind]}.`,
      keep: false,
    });
  }
  if (next.contract !== null && next.contract.revision !== prev?.contract?.revision) {
    out.push({
      category: 'contract',
      text:
        next.contract.revision === 1
          ? `Understood: ${next.contract.summary}`
          : `Contract revised: ${next.contract.summary}`,
      keep: false,
    });
  }
  if (next.total > 0 && next.met > (prev?.met ?? 0)) {
    out.push({
      category: 'requirements',
      text: `${String(next.met)} of ${String(next.total)} requirement${next.total === 1 ? '' : 's'} met.`,
      keep: false,
    });
  }
  return out;
}

/** The shortest gap between two announcements. */
export const ANNOUNCE_INTERVAL_MS = 2_000;

/** Time and one-shot timers, injected so tests step them. */
export interface AnnounceClock {
  now(): number;
  schedule(callback: () => void, ms: number): () => void;
}

/** The browser clock. */
export const BROWSER_ANNOUNCE_CLOCK: AnnounceClock = {
  now: () => Date.now(),
  schedule(callback, ms) {
    const handle = setTimeout(callback, ms);
    return () => {
      clearTimeout(handle);
    };
  },
};

/** A rate-limited announcement queue; see the module comment. */
export interface AnnouncementQueue {
  push(announcements: readonly Announcement[]): void;
  /** Cancels the pending timer (unmount). */
  dispose(): void;
}

/** Creates the queue; `speak` receives at most one text per {@link ANNOUNCE_INTERVAL_MS}. */
export function createAnnouncementQueue(
  speak: (text: string) => void,
  clock: AnnounceClock = BROWSER_ANNOUNCE_CLOCK,
): AnnouncementQueue {
  let latest = new Map<AnnouncementCategory, Announcement>();
  let kept: Announcement[] = [];
  let lastSpoken = Number.NEGATIVE_INFINITY;
  let cancel: (() => void) | null = null;

  const flush = (): void => {
    cancel = null;
    const pending = [...kept, ...latest.values()];
    kept = [];
    latest = new Map();
    if (pending.length === 0) return;
    pending.sort((a, b) => ORDER.indexOf(a.category) - ORDER.indexOf(b.category));
    const seen = new Set<string>();
    const text = pending
      .map((item) => item.text)
      .filter((item) => (seen.has(item) ? false : (seen.add(item), true)))
      .join(' ');
    lastSpoken = clock.now();
    speak(text);
  };

  return {
    push(announcements) {
      if (announcements.length === 0) return;
      for (const item of announcements) {
        if (item.keep) kept.push(item);
        else latest.set(item.category, item);
      }
      if (cancel !== null) return;
      const wait = lastSpoken + ANNOUNCE_INTERVAL_MS - clock.now();
      if (wait <= 0) flush();
      else cancel = clock.schedule(flush, wait);
    },
    dispose() {
      cancel?.();
      cancel = null;
    },
  };
}
