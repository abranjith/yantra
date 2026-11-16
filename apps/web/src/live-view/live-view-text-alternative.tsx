/**
 * The live view's text alternative (FEAT-069): the task page's host and
 * title, and a link to the RunTimeline, for anyone who cannot or does not want
 * to watch the pixels. Always shown in the cockpit, and the only view while
 * the run uses a visible window or has no live page.
 *
 * Host and title are page-derived, untrusted text: React renders them as text
 * only, never as markup.
 */

import { Link, browserViewportMessage, type BrowserViewportState } from '@yantra/ui';
import type { ReactNode } from 'react';

import type { LiveViewSnapshot } from './live-view-store.js';

/** Where the RunTimeline lives in the cockpit (the Engine panel's heading). */
export const RUN_TIMELINE_ANCHOR = '#cockpit-engine';

export interface LiveViewTextAlternativeProps {
  readonly snapshot: Pick<LiveViewSnapshot, 'state' | 'reason' | 'page'>;
}

const STATE_WORD: Readonly<Record<BrowserViewportState, string>> = {
  connecting: 'connecting',
  live: 'live',
  protected: 'hidden (protected screen)',
  headed: 'in a visible window',
  no_page: 'no live page',
  unavailable: 'unavailable',
  reconnecting: 'reconnecting',
};

/** See the module comment. */
export function LiveViewTextAlternative({ snapshot }: LiveViewTextAlternativeProps): ReactNode {
  const { state, reason, page } = snapshot;
  const detail = browserViewportMessage(state, reason);
  return (
    <section
      aria-label="Live view, as text"
      data-part="live-view-text"
      className="flex flex-col gap-1"
    >
      <p className="type-label text-ink-2">Live view: {STATE_WORD[state]}</p>
      {page === null ? (
        detail === null ? null : (
          <p className="type-body text-ink-2">{detail}</p>
        )
      ) : (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
          <dt className="type-label text-ink-2">Site</dt>
          <dd className="type-body break-words text-ink" data-part="live-view-host">
            {page.host}
          </dd>
          <dt className="type-label text-ink-2">Page</dt>
          <dd className="type-body break-words text-ink" data-part="live-view-title">
            {page.title}
          </dd>
        </dl>
      )}
      <p className="type-body">
        <Link href={RUN_TIMELINE_ANCHOR}>What the run is doing, step by step</Link>
      </p>
    </section>
  );
}

/** What the cockpit announces when the view changes state; null for anything else. */
export function liveViewAnnouncement(
  previous: BrowserViewportState | null,
  next: BrowserViewportState,
): string | null {
  if (previous === next) return null;
  switch (next) {
    case 'protected':
      return 'Live view hidden: a protected screen is showing.';
    case 'live':
      // Only coming back is news; the first frame after connecting is not.
      return previous === 'protected' || previous === 'unavailable' || previous === 'reconnecting'
        ? 'Live view showing again.'
        : null;
    case 'headed':
      return 'This run uses a visible browser window.';
    case 'unavailable':
      return 'Live view unavailable.';
    default:
      return null;
  }
}
