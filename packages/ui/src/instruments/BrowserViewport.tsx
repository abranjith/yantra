import type { ReactNode } from 'react';

import { Icon } from '../icons/Icon.js';
import type { IconName } from '../icons/registry.js';
import { cn } from '../lib/cn.js';

/**
 * BrowserViewport (FEAT-069): the run's task page, live, behind the cockpit
 * HUD.
 *
 * Presentational only. The app owns the frames: it receives the canvas
 * through `draw` and paints decoded frames into it, and it chooses `state`.
 * Every state but `live` covers the canvas with a message, so a stale image
 * can never show through one. Icons come from the registry and color from
 * tokens only. The canvas is an image with an accessible name; the cockpit
 * also offers a text alternative and announces state changes politely, so
 * this component is not a live region.
 */

/** What the viewport shows. */
export type BrowserViewportState =
  'connecting' | 'live' | 'protected' | 'headed' | 'no_page' | 'unavailable' | 'reconnecting';

/** Why the view is unavailable (the protocol's closed set). */
export type BrowserViewportReason =
  'capture_failed' | 'incompatible_worker' | 'protection_unverifiable' | 'none';

export interface BrowserViewportProps {
  readonly state: BrowserViewportState;
  readonly reason?: BrowserViewportReason;
  /** Host and title of the task page, rendered as text only. */
  readonly page?: { readonly host: string; readonly title: string } | null;
  /** Receives the canvas element (and null when it unmounts). */
  readonly draw?: (canvas: HTMLCanvasElement | null) => void;
  readonly className?: string;
}

/** The message each non-live state shows; also the canvas's accessible name then. */
export const BROWSER_VIEWPORT_MESSAGES: Readonly<
  Record<Exclude<BrowserViewportState, 'live' | 'unavailable'>, string>
> = {
  connecting: 'Connecting to the live view…',
  protected: 'Protected screen — hidden',
  headed: 'Running in a visible window',
  no_page: 'This run reads pages in the background; there is no live page to show',
  reconnecting: 'Reconnecting to the live view…',
};

/** The message for `unavailable`, by reason. */
export const BROWSER_VIEWPORT_UNAVAILABLE: Readonly<Record<BrowserViewportReason, string>> = {
  capture_failed: 'The live view stopped. The run itself is not affected.',
  incompatible_worker:
    'This run was started by a different Yantra version, so its live view is not available here.',
  protection_unverifiable:
    'Yantra could not confirm the screen is safe to show, so the live view stays hidden.',
  none: 'The live view is not available.',
};

const STATE_ICON: Readonly<Record<Exclude<BrowserViewportState, 'live'>, IconName>> = {
  connecting: 'action.retry',
  protected: 'glyph.protected',
  headed: 'liveView.headed',
  no_page: 'liveView.noPage',
  unavailable: 'liveView.unavailable',
  reconnecting: 'action.retry',
};

/** The viewport's message for a state, or null while live. */
export function browserViewportMessage(
  state: BrowserViewportState,
  reason: BrowserViewportReason = 'none',
): string | null {
  if (state === 'live') return null;
  if (state === 'unavailable') return BROWSER_VIEWPORT_UNAVAILABLE[reason];
  return BROWSER_VIEWPORT_MESSAGES[state];
}

/** See the module comment. */
export function BrowserViewport({
  state,
  reason = 'none',
  page = null,
  draw,
  className,
}: BrowserViewportProps): ReactNode {
  const message = browserViewportMessage(state, reason);
  const name =
    message ??
    (page !== null && page.host.length > 0
      ? `Live view of ${page.host}`
      : 'Live view of the task page');
  return (
    <div
      data-instrument="browser-viewport"
      data-state={state}
      className={cn('relative h-full w-full overflow-hidden bg-sunken', className)}
    >
      <canvas
        ref={draw}
        role="img"
        aria-label={name}
        className={cn('h-full w-full object-contain', message !== null && 'invisible')}
      />
      {message === null ? null : (
        <div
          data-part="viewport-message"
          className="absolute inset-0 flex items-center justify-center p-6"
        >
          <p className="flex max-w-prose items-center gap-2 rounded-control bg-surface px-4 py-3 text-ink">
            <Icon
              name={STATE_ICON[state as Exclude<BrowserViewportState, 'live'>]}
              size={20}
              className="shrink-0"
            />
            <span className="type-body">{message}</span>
          </p>
        </div>
      )}
    </div>
  );
}
