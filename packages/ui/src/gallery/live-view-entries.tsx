/**
 * Gallery entries for the FEAT-069 live view: BrowserViewport in every state
 * it can show, with deterministic data. The harness renders each entry in
 * light and dark, Glass and Solid, and runs axe on it.
 */

import type { ReactNode } from 'react';

import {
  BrowserViewport,
  type BrowserViewportReason,
  type BrowserViewportState,
} from '../instruments/BrowserViewport.js';

import type { GalleryEntry } from './entries.js';

const PAGE = { host: 'shop.example', title: 'Checkout — Shop' } as const;

function ViewportSample({
  state,
  reason,
}: {
  readonly state: BrowserViewportState;
  readonly reason?: BrowserViewportReason;
}): ReactNode {
  return (
    <figure className="flex flex-col gap-2">
      <div className="h-48 w-80 rounded-control">
        <BrowserViewport
          state={state}
          {...(reason === undefined ? {} : { reason })}
          page={state === 'live' ? PAGE : null}
        />
      </div>
      <figcaption className="type-label text-ink-2">
        {reason === undefined ? state : `${state} · ${reason}`}
      </figcaption>
    </figure>
  );
}

function ViewportSheet(): ReactNode {
  return (
    <div className="flex flex-wrap gap-4">
      <ViewportSample state="live" />
      <ViewportSample state="connecting" />
      <ViewportSample state="protected" />
      <ViewportSample state="headed" />
      <ViewportSample state="no_page" />
      <ViewportSample state="reconnecting" />
      <ViewportSample state="unavailable" reason="capture_failed" />
      <ViewportSample state="unavailable" reason="incompatible_worker" />
      <ViewportSample state="unavailable" reason="protection_unverifiable" />
    </div>
  );
}

export const LIVE_VIEW_ENTRIES: readonly GalleryEntry[] = [
  {
    id: 'instrument-browser-viewport',
    title: 'BrowserViewport',
    primitive: null,
    render: () => <ViewportSheet />,
    interactive: false,
  },
];
